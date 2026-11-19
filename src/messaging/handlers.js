import { revokeAttendance } from '../attendance/repository.js';
import { issueTickets, revokeOrder } from '../passes/repository.js';

// Un handler por tipo de mensaje consumido. Recibe `data` del sobre, el `client` de una transacción
// ya abierta y el `envelope` completo. Lo que no tenga handler se confirma sin efecto.

/** Marca el evento como cerrado: un snapshot posterior no lo vuelve a publicar. */
async function closeEvent(client, eventId, status) {
  await client.query(`INSERT INTO closed_events (event_id, status) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING`, [
    eventId,
    status,
  ]);
}

/**
 * Serializa por usuario los handlers que tocan su nombre. El consumidor procesa varios mensajes a la vez:
 * sin esto, un account.display_name_set podía leer `deleted_users` antes de que se confirmara el borrado
 * y recrear el nombre después. Con el candado, el que llega segundo espera y ve lo que hizo el primero.
 * Es de transacción: se suelta solo con el COMMIT o el ROLLBACK.
 */
export async function lockUser(client, userId) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('booking.user_names'), hashtext($1))`, [userId]);
}

/**
 * Guarda el nombre visible. Un mensaje más viejo que el guardado (llegó tarde) no lo pisa, y el de una
 * cuenta ya borrada no se guarda: su id quedó en `deleted_users`.
 */
async function upsertName(client, userId, displayName, at) {
  await lockUser(client, userId);
  await client.query(
    `INSERT INTO user_names (user_id, display_name, updated_at)
     SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM deleted_users WHERE user_id = $1)
     ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = EXCLUDED.updated_at
     WHERE user_names.updated_at < EXCLUDED.updated_at`,
    [userId, displayName, at],
  );
}

/** event.published y event.updated traen el snapshot completo. Se ignora uno más viejo que el guardado. */
async function upsertSnapshot(data, client) {
  const { rowCount } = await client.query('SELECT 1 FROM closed_events WHERE event_id = $1', [data.eventId]);
  if (rowCount > 0) return; // evento cancelado o expirado: un snapshot retrasado no lo reabre
  await client.query(
    `INSERT INTO event_projection (event_id, title, starts_at, ends_at, capacity, ticketed, status, version, organizer_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (event_id) DO UPDATE SET
       organizer_id = EXCLUDED.organizer_id, title = EXCLUDED.title, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
       capacity = EXCLUDED.capacity, ticketed = EXCLUDED.ticketed, status = EXCLUDED.status,
       version = EXCLUDED.version, updated_at = now()
     WHERE event_projection.version < EXCLUDED.version`,
    [data.eventId, data.title, data.startsAt, data.endsAt, data.capacity, data.ticketed, data.status, data.version, data.organizerId],
  );
}

export const handlers = {
  'event.published': upsertSnapshot,
  'event.updated': upsertSnapshot,

  'event.expired': async (data, client) => {
    await closeEvent(client, data.eventId, 'expired');
    await client.query(`UPDATE event_projection SET status = 'expired', updated_at = now() WHERE event_id = $1`, [
      data.eventId,
    ]);
  },

  // contracts/README.md § Evento cancelado: se revocan los pases y se avisa por cada asistente.
  'event.cancelled': async (data, client, envelope) => {
    await closeEvent(client, data.eventId, 'cancelled');
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
    // Primero el candado del usuario: un account.display_name_set concurrente espera a este borrado.
    await lockUser(client, data.userId);
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
    // La lápida va antes de borrar el nombre: un account.display_name_set atrasado ya no lo recrea.
    await client.query(
      'INSERT INTO deleted_users (user_id, deleted_at) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING',
      [data.userId, data.deletedAt],
    );
    await client.query('DELETE FROM user_names WHERE user_id = $1', [data.userId]);
  },

  // SCRUM-141: el nombre que ve el organizador en la lista de asistentes. Solo trae id y nombre.
  'account.display_name_set': async (data, client) => {
    await upsertName(client, data.userId, data.displayName, data.setAt);
  },

  // RF11 → RF10: pago aprobado. Crea la asistencia con un pase QR por boleta.
  'order.approved': async (data, client, envelope) => {
    await issueTickets(client, data, envelope.eventId);
  },

  // Reembolso hecho: los pases de la orden quedan revocados.
  'order.refunded': async (data, client, envelope) => {
    await revokeOrder(client, data, envelope.eventId);
  },
};
