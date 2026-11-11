import { revokeAttendance } from '../attendance/repository.js';

// Un handler por tipo de mensaje consumido. Recibe `data` del sobre, el `client` de una transacción
// ya abierta y el `envelope` completo. Lo que no tenga handler se confirma sin efecto.

/** event.published y event.updated traen el snapshot completo. Se ignora uno más viejo que el guardado. */
async function upsertSnapshot(data, client) {
  await client.query(
    `INSERT INTO event_projection (event_id, title, starts_at, ends_at, capacity, ticketed, status, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (event_id) DO UPDATE SET
       title = EXCLUDED.title, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
       capacity = EXCLUDED.capacity, ticketed = EXCLUDED.ticketed, status = EXCLUDED.status,
       version = EXCLUDED.version, updated_at = now()
     WHERE event_projection.version < EXCLUDED.version`,
    [data.eventId, data.title, data.startsAt, data.endsAt, data.capacity, data.ticketed, data.status, data.version],
  );
}

export const handlers = {
  'event.published': upsertSnapshot,
  'event.updated': upsertSnapshot,

  'event.expired': async (data, client) => {
    await client.query(`UPDATE event_projection SET status = 'expired', updated_at = now() WHERE event_id = $1`, [
      data.eventId,
    ]);
  },

  // contracts/README.md § Evento cancelado: se revocan los pases y se avisa por cada asistente.
  'event.cancelled': async (data, client, envelope) => {
    await client.query(
      `UPDATE event_projection SET status = 'cancelled', version = GREATEST(version, $2), updated_at = now()
       WHERE event_id = $1`,
      [data.eventId, data.version],
    );
    const { rows } = await client.query(`SELECT id, user_id FROM attendances WHERE event_id = $1 AND status = 'confirmed'`, [
      data.eventId,
    ]);
    for (const row of rows) {
      await revokeAttendance(client, {
        attendanceId: row.id,
        eventId: data.eventId,
        userId: row.user_id,
        reason: 'event_cancelled',
        causationId: envelope.eventId,
      });
    }
  },

  // Derecho de supresión (Ley 1581): libera sus cupos y borra sus asistencias y pases.
  'account.deleted': async (data, client, envelope) => {
    const { rows } = await client.query(
      `SELECT id, event_id FROM attendances WHERE user_id = $1 AND status = 'confirmed' ORDER BY event_id`,
      [data.userId],
    );
    for (const row of rows) {
      await revokeAttendance(client, {
        attendanceId: row.id,
        eventId: row.event_id,
        userId: data.userId,
        reason: 'account_deleted',
        causationId: envelope.eventId,
      });
    }
    await client.query('DELETE FROM attendances WHERE user_id = $1', [data.userId]);
  },
};
