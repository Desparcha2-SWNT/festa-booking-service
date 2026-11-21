import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getSchemaRegistry } from './schemaRegistry.js';

/**
 * Publica lo pendiente en `outbox` con publisher confirms (ver contracts/README.md § Publicar).
 *
 * `FOR UPDATE SKIP LOCKED` evita que dos instancias de este worker (o dos réplicas del
 * servicio) seleccionen la misma fila. El `eventId`/`correlationId` vienen ya fijados desde
 * que se creó la fila (ver migrations/001_outbox.sql): si esta transacción se cae después de
 * publicar pero antes de confirmar el `UPDATE`, el siguiente intento republica con el MISMO
 * eventId, y el inbox del consumidor lo deduplica por `processed_events` en vez de tratarlo
 * como un evento nuevo.
 */
export function startOutboxPublisher(connection, { intervalMs = 2000 } = {}) {
  let stopped = false;
  const registry = getSchemaRegistry(config.contractsDir);
  let channelPromise = connection.createConfirmChannel();

  const tick = async () => {
    if (stopped) return;
    const client = await pool.connect();
    try {
      const channel = await channelPromise;
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, event_id, created_at, correlation_id, causation_id, exchange, routing_key, payload FROM outbox
         WHERE sent_at IS NULL ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED`,
      );

      for (const row of rows) {
        const envelope = {
          eventId: row.event_id,
          eventType: row.routing_key,
          // Versión del esquema de `data` (x-version del catálogo): attendance.* ya es 2, el resto sigue en 1.
          version: registry.getVersion(row.routing_key),
          // Cuándo ocurrió el hecho (la fila del outbox), no cuándo se publica: un reintento conserva la misma fecha.
          occurredAt: new Date(row.created_at).toISOString(),
          producer: 'booking-service',
          correlationId: row.correlation_id,
          causationId: row.causation_id,
          data: row.payload,
        };
        const content = Buffer.from(JSON.stringify(envelope));

        await new Promise((resolve, reject) => {
          channel.publish(
            row.exchange,
            row.routing_key,
            content,
            {
              persistent: true,
              contentType: 'application/json',
              messageId: envelope.eventId,
              type: envelope.eventType,
              // contracts/README.md § Publicar. Solo tiene sentido si esto nació de una
              // petición HTTP (correlationId); si nació de consumir otro mensaje, no hay.
              headers: row.correlation_id ? { 'x-correlation-id': row.correlation_id } : {},
            },
            (err) => (err ? reject(err) : resolve()),
          );
        });

        await client.query('UPDATE outbox SET sent_at = now() WHERE id = $1', [row.id]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error(err, 'fallo publicando el outbox, se reintenta en el siguiente tick');
      channelPromise = connection.createConfirmChannel();
    } finally {
      client.release();
      if (!stopped) setTimeout(tick, intervalMs);
    }
  };

  tick();
  return { stop: () => { stopped = true; } };
}
