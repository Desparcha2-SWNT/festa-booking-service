import { pool, withTransaction } from '../db/pool.js';
import { enqueue } from '../messaging/outboxRepository.js';

const EXCHANGE = 'festa.booking';

/**
 * Toma el candado de la fila del evento. Todas las operaciones que cambian el conteo pasan por
 * aquí, así dos confirmaciones simultáneas no pueden ocupar el mismo último cupo.
 */
export async function lockEvent(client, eventId) {
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
    // clock_timestamp(): la hora real del cambio, no la del inicio de la transacción. Así compara bien
    // con closed_events.closed_at (ver src/messaging/handlers.js).
    `UPDATE attendances SET status = 'cancelled', cancelled_at = clock_timestamp() WHERE id = $1 RETURNING cancelled_at`,
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

/**
 * «Mis planes» (SCRUM-142): las asistencias gratis del usuario. Las entradas pagas van en /passes/mine.
 *
 * - `upcoming`: confirmadas de eventos que no han terminado, del más cercano al más lejano.
 * - `past`: confirmadas de eventos que ya terminaron, más las que se anularon porque el organizador
 *   canceló el evento (así el plan no desaparece sin explicación), del más reciente al más antiguo.
 *
 * Las que el usuario canceló él mismo no salen. Una anulación por evento cancelado se reconoce porque
 * el evento quedó cancelado y la asistencia se anuló en la misma transacción que lo cerró o después
 * (`cancelled_at >= closed_at`); las que el usuario canceló antes quedan con una hora anterior.
 */
export async function listMyPlans(userId, { when, limit, offset }) {
  const upcoming = when === 'upcoming';
  const { rows } = await pool.query(
    `WITH plans AS (
       SELECT a.id, a.event_id, a.confirmed_at, e.title, e.starts_at, e.ends_at, e.venue_name, e.cover_image_url,
              e.status AS event_status, a.status = 'cancelled' AS cancelled_by_event,
              a.status = 'confirmed' AND e.ends_at > now() AS is_upcoming
       FROM attendances a
       JOIN event_projection e ON e.event_id = a.event_id
       LEFT JOIN closed_events c ON c.event_id = a.event_id AND c.status = 'cancelled'
       WHERE a.user_id = $1 AND a.source = 'rsvp'
         AND (a.status = 'confirmed' OR (c.event_id IS NOT NULL AND a.cancelled_at >= c.closed_at))
     )
     SELECT *, COUNT(*) OVER () AS total FROM plans
     WHERE is_upcoming = $2
     ORDER BY starts_at ${upcoming ? 'ASC' : 'DESC'}, id
     LIMIT $3 OFFSET $4`,
    [userId, upcoming, limit, offset],
  );

  let total = rows.length > 0 ? Number(rows[0].total) : 0;
  if (rows.length === 0 && offset > 0) total = await countMyPlans(userId, upcoming);

  return {
    when,
    total,
    limit,
    offset,
    items: rows.map((r) => ({
      attendanceId: r.id,
      eventId: r.event_id,
      title: r.title,
      startsAt: r.starts_at.toISOString(),
      endsAt: r.ends_at.toISOString(),
      venueName: r.venue_name,
      coverImageUrl: r.cover_image_url,
      status: r.cancelled_by_event ? 'event_cancelled' : 'confirmed',
      eventStatus: r.event_status,
      confirmedAt: r.confirmed_at.toISOString(),
    })),
  };
}

/** Total de una pestaña cuando la página pedida ya quedó vacía (COUNT(*) OVER() no tiene filas). */
async function countMyPlans(userId, upcoming) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS total
     FROM attendances a
     JOIN event_projection e ON e.event_id = a.event_id
     LEFT JOIN closed_events c ON c.event_id = a.event_id AND c.status = 'cancelled'
     WHERE a.user_id = $1 AND a.source = 'rsvp'
       AND (a.status = 'confirmed' OR (c.event_id IS NOT NULL AND a.cancelled_at >= c.closed_at))
       AND (a.status = 'confirmed' AND e.ends_at > now()) = $2`,
    [userId, upcoming],
  );
  return Number(rows[0].total);
}
