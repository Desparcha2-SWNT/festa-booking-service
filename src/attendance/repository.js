import { pool, withTransaction } from '../db/pool.js';
import { enqueue } from '../messaging/outboxRepository.js';

const EXCHANGE = 'festa.booking';

/**
 * Toma el candado de la fila del evento. Todas las operaciones que cambian el conteo pasan por
 * aquí, así dos confirmaciones simultáneas no pueden ocupar el mismo último cupo.
 */
async function lockEvent(client, eventId) {
  const { rows } = await client.query('SELECT * FROM event_projection WHERE event_id = $1 FOR UPDATE', [eventId]);
  return rows[0];
}

async function findActiveRsvp(db, eventId, userId) {
  const { rows } = await db.query(
    `SELECT a.id, a.confirmed_at,
       COALESCE(array_agg(p.id) FILTER (WHERE p.id IS NOT NULL), '{}') AS pass_ids,
       COALESCE(bool_or(p.used_at IS NOT NULL), false) AS used
     FROM attendances a LEFT JOIN passes p ON p.attendance_id = a.id
     WHERE a.event_id = $1 AND a.user_id = $2 AND a.status = 'confirmed' AND a.source = 'rsvp'
     GROUP BY a.id`,
    [eventId, userId],
  );
  return rows[0];
}

function hasEnded(event) {
  return event.ends_at <= new Date();
}

function toAttendance(eventId, attendance, attendeeCount) {
  return {
    attendanceId: attendance.id,
    eventId,
    status: 'confirmed',
    passIds: attendance.pass_ids,
    attendeeCount,
    confirmedAt: attendance.confirmed_at.toISOString(),
  };
}

export function toConfirmedMessage(event, attendance, userId, attendeeCount, { source = 'rsvp', orderId } = {}) {
  return {
    attendanceId: attendance.id,
    eventId: event.event_id,
    eventTitle: event.title,
    eventStartsAt: event.starts_at.toISOString(),
    userId,
    source,
    ...(orderId ? { orderId } : {}),
    passIds: attendance.pass_ids,
    attendeeCount,
    confirmedAt: attendance.confirmed_at.toISOString(),
  };
}

/** Confirma el RSVP de un evento gratis. Repetirlo devuelve la misma asistencia, sin publicar. */
export async function confirmAttendance(eventId, userId, correlationId) {
  return withTransaction(async (client) => {
    const event = await lockEvent(client, eventId);
    if (!event) return { outcome: 'not_found' };

    const existing = await findActiveRsvp(client, eventId, userId);
    if (existing) {
      return { outcome: 'already_confirmed', attendance: toAttendance(eventId, existing, event.attendee_count) };
    }

    if (event.status !== 'published' || hasEnded(event)) return { outcome: 'closed' };
    if (event.ticketed) return { outcome: 'requires_ticket' };
    if (event.capacity !== null && event.attendee_count >= event.capacity) return { outcome: 'full' };

    const inserted = await client.query(
      `INSERT INTO attendances (event_id, user_id, source) VALUES ($1, $2, 'rsvp') RETURNING id, confirmed_at`,
      [eventId, userId],
    );
    const row = inserted.rows[0];
    const pass = await client.query(
      'INSERT INTO passes (attendance_id, event_id, user_id) VALUES ($1, $2, $3) RETURNING id',
      [row.id, eventId, userId],
    );
    const counted = await client.query(
      `UPDATE event_projection SET attendee_count = attendee_count + 1, updated_at = now()
       WHERE event_id = $1 RETURNING attendee_count`,
      [eventId],
    );

    const attendance = { ...row, pass_ids: [pass.rows[0].id] };
    const attendeeCount = counted.rows[0].attendee_count;
    await enqueue(client, {
      exchange: EXCHANGE,
      routingKey: 'attendance.confirmed',
      payload: toConfirmedMessage(event, attendance, userId, attendeeCount),
      correlationId,
    });

    return { outcome: 'confirmed', attendance: toAttendance(eventId, attendance, attendeeCount) };
  });
}

/**
 * Cancela una asistencia, revoca sus pases, descuenta el cupo y encola `attendance.cancelled`.
 * Quien la llama ya abrió la transacción. La usan el usuario y los handlers del inbox.
 */
export async function revokeAttendance(client, { attendanceId, eventId, userId, reason, correlationId, causationId }) {
  const cancelled = await client.query(
    `UPDATE attendances SET status = 'cancelled', cancelled_at = now() WHERE id = $1 RETURNING cancelled_at`,
    [attendanceId],
  );
  const passes = await client.query(
    'UPDATE passes SET revoked_at = now() WHERE attendance_id = $1 AND revoked_at IS NULL RETURNING id',
    [attendanceId],
  );
  // Una asistencia con boletas ocupa un cupo por pase; un RSVP, uno solo.
  const seats = Math.max(passes.rows.length, 1);
  const counted = await client.query(
    `UPDATE event_projection SET attendee_count = GREATEST(attendee_count - $2, 0), updated_at = now()
     WHERE event_id = $1 RETURNING attendee_count`,
    [eventId, seats],
  );

  await enqueue(client, {
    exchange: EXCHANGE,
    routingKey: 'attendance.cancelled',
    payload: {
      attendanceId,
      eventId,
      userId,
      reason,
      revokedPassIds: passes.rows.map((p) => p.id),
      attendeeCount: counted.rows[0].attendee_count,
      cancelledAt: cancelled.rows[0].cancelled_at.toISOString(),
    },
    correlationId,
    causationId,
  });

  return counted.rows[0].attendee_count;
}

export async function cancelAttendance(eventId, userId, correlationId) {
  return withTransaction(async (client) => {
    const event = await lockEvent(client, eventId);
    if (!event) return { outcome: 'not_found' };

    const existing = await findActiveRsvp(client, eventId, userId);
    if (!existing) return { outcome: 'not_attending' };
    if (existing.used || hasEnded(event)) return { outcome: 'closed' };

    const attendeeCount = await revokeAttendance(client, {
      attendanceId: existing.id,
      eventId,
      userId,
      reason: 'user',
      correlationId,
    });
    return { outcome: 'cancelled', attendeeCount };
  });
}

export async function getAttendanceStatus(eventId, userId) {
  const { rows } = await pool.query('SELECT capacity, attendee_count FROM event_projection WHERE event_id = $1', [eventId]);
  if (!rows[0]) return null;

  const { capacity, attendee_count: attendeeCount } = rows[0];
  const mine = await findActiveRsvp(pool, eventId, userId);
  return {
    eventId,
    capacity,
    attendeeCount,
    confirmed: Boolean(mine),
    attendanceId: mine?.id,
    passIds: mine?.pass_ids,
  };
}
