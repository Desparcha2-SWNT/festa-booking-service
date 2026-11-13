import { pool, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { enqueue } from '../messaging/outboxRepository.js';
import { revokeAttendance, toConfirmedMessage } from '../attendance/repository.js';
import { parseQr, qrFor } from './qr.js';

const EXCHANGE = 'festa.booking';
const iso = (d) => new Date(d).toISOString();

function toPass(row) {
  const status = row.revoked_at ? 'revoked' : row.used_at ? 'used' : 'valid';
  return {
    passId: row.id,
    eventId: row.event_id,
    attendanceId: row.attendance_id,
    eventTitle: row.title,
    eventStartsAt: row.starts_at ? iso(row.starts_at) : undefined,
    eventEndsAt: row.ends_at ? iso(row.ends_at) : undefined,
    source: row.source,
    status,
    usedAt: row.used_at ? iso(row.used_at) : null,
    // Solo un pase vigente lleva QR: uno usado o revocado no debe mostrarse como entrada.
    qr: status === 'valid' ? qrFor(row.id, row.event_id) : null,
  };
}

const PASS_SELECT = `SELECT p.*, a.source, e.title, e.starts_at, e.ends_at
  FROM passes p JOIN attendances a ON a.id = p.attendance_id JOIN event_projection e ON e.event_id = p.event_id`;

/** «Mis entradas»: los pases del usuario, los de eventos vigentes primero. */
export async function listMyPasses(userId) {
  const { rows } = await pool.query(
    `${PASS_SELECT} WHERE p.user_id = $1 ORDER BY (e.ends_at > now()) DESC, e.starts_at ASC LIMIT 200`,
    [userId],
  );
  return rows.map(toPass);
}

export async function getMyPass(passId, userId) {
  const { rows } = await pool.query(`${PASS_SELECT} WHERE p.id = $1 AND p.user_id = $2`, [passId, userId]);
  return rows[0] ? toPass(rows[0]) : null;
}

/**
 * RF10: ingreso con QR (contracts/README.md § Ingreso). Verifica la firma, que el evento coincida,
 * que quien escanea sea el organizador (o admin), la ventana de ingreso, y marca el pase de forma
 * atómica para que sirva una sola vez. Publica pass.checked_in o pass.check_in_rejected.
 */
export async function checkIn({ qr, eventId, scannedBy, role, correlationId }) {
  const parsed = parseQr(qr);

  return withTransaction(async (client) => {
    const reject = async (reason, extra = {}) => {
      await enqueue(client, {
        exchange: EXCHANGE,
        routingKey: 'pass.check_in_rejected',
        payload: {
          ...(parsed.passId ? { passId: parsed.passId } : {}),
          eventId,
          scannedBy,
          reason,
          ...extra,
          rejectedAt: new Date().toISOString(),
        },
        correlationId,
      });
      return { outcome: 'rejected', reason, ...extra };
    };

    const { rows: events } = await client.query('SELECT * FROM event_projection WHERE event_id = $1', [eventId]);
    const event = events[0];
    if (!event) return { outcome: 'event_not_found' };
    if (role !== 'admin' && event.organizer_id !== scannedBy) return reject('not_organizer');
    if (!parsed.valid) return reject('invalid_signature');
    if (parsed.eventId !== eventId) return reject('wrong_event');

    const now = Date.now();
    const opens = new Date(event.starts_at).getTime() - config.checkInOpensMinutesBefore * 60_000;
    if (now < opens || now > new Date(event.ends_at).getTime() || ['cancelled', 'hidden'].includes(event.status)) {
      return reject('outside_window');
    }

    // Un solo uso (RNF7): solo una de varias lecturas simultáneas logra marcarlo.
    const { rows: marked } = await client.query(
      `UPDATE passes SET used_at = now() WHERE id = $1 AND event_id = $2 AND used_at IS NULL AND revoked_at IS NULL
       RETURNING id, attendance_id, user_id, used_at`,
      [parsed.passId, eventId],
    );
    if (marked.length === 0) {
      const { rows } = await client.query('SELECT used_at, revoked_at FROM passes WHERE id = $1', [parsed.passId]);
      const pass = rows[0];
      if (!pass) return reject('invalid_signature');
      if (pass.revoked_at) return reject('revoked');
      return reject('already_used', { firstUsedAt: iso(pass.used_at) });
    }

    const pass = marked[0];
    const payload = {
      passId: pass.id,
      attendanceId: pass.attendance_id,
      eventId,
      userId: pass.user_id,
      scannedBy,
      checkedInAt: iso(pass.used_at),
    };
    await enqueue(client, { exchange: EXCHANGE, routingKey: 'pass.checked_in', payload, correlationId });
    return { outcome: 'checked_in', pass: payload };
  });
}

/** Lista para el organizador en la entrada: cuántos van, cuántos ya entraron. */
export async function eventAttendance(eventId, requesterId, role) {
  const { rows: events } = await pool.query('SELECT * FROM event_projection WHERE event_id = $1', [eventId]);
  const event = events[0];
  if (!event) return { outcome: 'not_found' };
  if (role !== 'admin' && event.organizer_id !== requesterId) return { outcome: 'forbidden' };
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE revoked_at IS NULL)::int AS passes,
            COUNT(*) FILTER (WHERE used_at IS NOT NULL AND revoked_at IS NULL)::int AS checked_in
     FROM passes WHERE event_id = $1`,
    [eventId],
  );
  return {
    outcome: 'ok',
    summary: {
      eventId,
      capacity: event.capacity,
      attendeeCount: event.attendee_count,
      validPasses: rows[0].passes,
      checkedIn: rows[0].checked_in,
    },
  };
}

/**
 * order.approved: una asistencia `ticket` con un pase por boleta. Idempotente por order_id. El cupo
 * ya lo retuvo payment-service; aquí solo se refleja en attendee_count.
 */
export async function issueTickets(client, order, causationId) {
  const existing = await client.query('SELECT id FROM attendances WHERE order_id = $1', [order.orderId]);
  if (existing.rowCount > 0) return;

  const { rows: events } = await client.query('SELECT * FROM event_projection WHERE event_id = $1 FOR UPDATE', [order.eventId]);
  const event = events[0];
  // El evento aún no llega a la proyección (mensajes desordenados): error transitorio, se reintenta.
  if (!event) throw new Error(`evento ${order.eventId} aún no está en la proyección`);

  const { rows } = await client.query(
    `INSERT INTO attendances (event_id, user_id, source, order_id) VALUES ($1, $2, 'ticket', $3) RETURNING id, confirmed_at`,
    [order.eventId, order.buyerId, order.orderId],
  );
  const attendance = rows[0];
  const passIds = [];
  for (let i = 0; i < order.quantity; i++) {
    const pass = await client.query('INSERT INTO passes (attendance_id, event_id, user_id) VALUES ($1, $2, $3) RETURNING id', [
      attendance.id,
      order.eventId,
      order.buyerId,
    ]);
    passIds.push(pass.rows[0].id);
  }
  const counted = await client.query(
    `UPDATE event_projection SET attendee_count = attendee_count + $2, updated_at = now() WHERE event_id = $1 RETURNING attendee_count`,
    [order.eventId, order.quantity],
  );
  await enqueue(client, {
    exchange: EXCHANGE,
    routingKey: 'attendance.confirmed',
    payload: toConfirmedMessage(event, { ...attendance, pass_ids: passIds }, order.buyerId, counted.rows[0].attendee_count, {
      source: 'ticket',
      orderId: order.orderId,
    }),
    causationId,
  });
}

/** order.refunded: revoca la asistencia (y sus pases) de esa orden. */
export async function revokeOrder(client, refund, causationId) {
  const { rows } = await client.query(`SELECT id, user_id FROM attendances WHERE order_id = $1 AND status = 'confirmed' FOR UPDATE`, [
    refund.orderId,
  ]);
  if (!rows[0]) return;
  await revokeAttendance(client, {
    attendanceId: rows[0].id,
    eventId: refund.eventId,
    userId: rows[0].user_id,
    reason: 'refunded',
    causationId,
  });
}
