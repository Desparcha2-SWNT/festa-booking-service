// Flujo completo contra PostgreSQL real: proyección, RSVP, boletas pagadas, check-in de un solo uso y
// reembolso. Se salta sin TEST_DATABASE_URL (una base vacía; la prueba la limpia al empezar).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const DB = process.env.TEST_DATABASE_URL;
const contractsDir = process.env.FESTA_CONTRACTS_DIR ?? path.resolve('../festa-infra/contracts');
const hasContracts = fs.existsSync(path.join(contractsDir, 'events'));

const ORGANIZER = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const BUYER = '0b9c7d6e-5f4a-4b3c-8d2e-1a0b9c8d7e6f';
const STRANGER = '2b9c7d6e-5f4a-4b3c-8d2e-1a0b9c8d7e6f';

function validator(domain, name) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(JSON.parse(fs.readFileSync(path.join(contractsDir, `events/${domain}/${name}.schema.json`), 'utf8')));
}

describe.skipIf(!DB || !hasContracts)('booking-service con PostgreSQL', () => {
  let pool;
  let withTransaction;
  let handlers;
  let attendance;
  let passes;

  const envelopeId = () => crypto.randomUUID();
  const run = (type, data) => withTransaction((client) => handlers[type](data, client, { eventId: envelopeId(), eventType: type }));
  const outbox = async (routingKey) =>
    (await pool.query('SELECT payload FROM outbox WHERE routing_key = $1 ORDER BY created_at', [routingKey])).rows.map((r) => r.payload);
  const expectValid = (domain, name, payload) => {
    const validate = validator(domain, name);
    validate(payload);
    expect(validate.errors, JSON.stringify(validate.errors)).toBeNull();
  };

  function eventSnapshot(overrides = {}) {
    const startsAt = new Date(Date.now() + 30 * 60_000);
    return {
      eventId: crypto.randomUUID(), organizerId: ORGANIZER, organizerType: 'merchant', title: 'Noche de jazz', description: 'x',
      category: 'musical', startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 3 * 3600_000).toISOString(),
      venue: { name: 'Bloque G', address: 'ECI', location: { lat: 4.78, lng: -74.04 } }, capacity: 80, ticketed: false,
      priceCents: 0, currency: 'COP', featured: false, isLive: false, status: 'published', version: 1, updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    ({ pool, withTransaction } = await import('../src/db/pool.js'));
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const { migrate } = await import('../src/db/migrate.js');
    await migrate();
    ({ handlers } = await import('../src/messaging/handlers.js'));
    attendance = await import('../src/attendance/repository.js');
    passes = await import('../src/passes/repository.js');
  });
  afterAll(async () => pool?.end());

  it('RF7: RSVP a un evento gratis y QR de un solo uso (RF10/RNF7)', async () => {
    const event = eventSnapshot();
    await run('event.published', event);

    const confirmed = await attendance.confirmAttendance(event.eventId, BUYER, null);
    expect(confirmed.outcome).toBe('confirmed');
    expectValid('booking', 'attendance.confirmed', (await outbox('attendance.confirmed')).at(-1));

    const [mine] = await passes.listMyPasses(BUYER);
    expect(mine.status).toBe('valid');

    // Un desconocido no puede validar ingresos.
    const stranger = await passes.checkIn({ qr: mine.qr, eventId: event.eventId, scannedBy: STRANGER, role: 'user' });
    expect(stranger.reason).toBe('not_organizer');

    const first = await passes.checkIn({ qr: mine.qr, eventId: event.eventId, scannedBy: ORGANIZER, role: 'merchant' });
    expect(first.outcome).toBe('checked_in');
    expectValid('booking', 'pass.checked_in', (await outbox('pass.checked_in')).at(-1));

    const again = await passes.checkIn({ qr: mine.qr, eventId: event.eventId, scannedBy: ORGANIZER, role: 'merchant' });
    expect(again).toMatchObject({ outcome: 'rejected', reason: 'already_used' });
    for (const p of await outbox('pass.check_in_rejected')) expectValid('booking', 'pass.check_in_rejected', p);

    expect((await passes.listMyPasses(BUYER))[0]).toMatchObject({ status: 'used', qr: null });
  });

  it('dos lecturas simultáneas del mismo QR: solo una entra', async () => {
    const event = eventSnapshot();
    await run('event.published', event);
    await attendance.confirmAttendance(event.eventId, STRANGER, null);
    const [pass] = (await passes.listMyPasses(STRANGER)).filter((p) => p.eventId === event.eventId);
    const results = await Promise.all(
      [1, 2, 3].map(() => passes.checkIn({ qr: pass.qr, eventId: event.eventId, scannedBy: ORGANIZER, role: 'merchant' })),
    );
    expect(results.filter((r) => r.outcome === 'checked_in')).toHaveLength(1);
  });

  it('el ingreso se rechaza fuera de la ventana', async () => {
    const startsAt = new Date(Date.now() + 5 * 3600_000);
    const event = eventSnapshot({ startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 3600_000).toISOString() });
    await run('event.published', event);
    await attendance.confirmAttendance(event.eventId, BUYER, null);
    const pass = (await passes.listMyPasses(BUYER)).find((p) => p.eventId === event.eventId);
    const result = await passes.checkIn({ qr: pass.qr, eventId: event.eventId, scannedBy: ORGANIZER, role: 'merchant' });
    expect(result.reason).toBe('outside_window');
  });

  it('RF11: order.approved emite un pase por boleta (una sola vez) y order.refunded los revoca', async () => {
    const event = eventSnapshot({ ticketed: true, priceCents: 2_500_000 });
    await run('event.published', event);
    const order = {
      orderId: crypto.randomUUID(), eventId: event.eventId, organizerId: ORGANIZER, buyerId: BUYER, quantity: 3,
      unitPriceCents: 2_500_000, subtotalCents: 7_500_000, commissionCents: 600_000, totalCents: 8_100_000, currency: 'COP',
      paymentMethod: 'NEQUI', providerTransactionId: 'tx', approvedAt: new Date().toISOString(),
    };
    await run('order.approved', order);
    await run('order.approved', order); // repetido: sin efecto

    const tickets = (await passes.listMyPasses(BUYER)).filter((p) => p.eventId === event.eventId);
    expect(tickets).toHaveLength(3);
    const confirmed = (await outbox('attendance.confirmed')).at(-1);
    expect(confirmed).toMatchObject({ source: 'ticket', orderId: order.orderId, attendeeCount: 3 });
    expectValid('booking', 'attendance.confirmed', confirmed);

    await run('order.refunded', { orderId: order.orderId, eventId: event.eventId, buyerId: BUYER, amountCents: 8_100_000, refundedBy: ORGANIZER, refundedAt: new Date().toISOString() });
    const after = (await passes.listMyPasses(BUYER)).filter((p) => p.eventId === event.eventId);
    expect(after.every((p) => p.status === 'revoked')).toBe(true);
    const cancelled = (await outbox('attendance.cancelled')).at(-1);
    expect(cancelled).toMatchObject({ reason: 'refunded', attendeeCount: 0 });
    expectValid('booking', 'attendance.cancelled', cancelled);
  });

  it('un evento ticketed no admite RSVP gratis', async () => {
    const event = eventSnapshot({ ticketed: true, priceCents: 1000 });
    await run('event.published', event);
    expect((await attendance.confirmAttendance(event.eventId, BUYER, null)).outcome).toBe('requires_ticket');
  });

  it('un snapshot retrasado no reabre un evento expirado', async () => {
    const event = eventSnapshot({ version: 1 });
    await run('event.published', event);
    await run('event.expired', { eventId: event.eventId, expiredAt: new Date().toISOString(), isLive: false });
    // event.expired no lleva versión: el event.updated retrasado (versión 2) no debe pasar la guarda.
    await run('event.updated', { ...event, version: 2, status: 'published' });
    const { rows } = await pool.query('SELECT status FROM event_projection WHERE event_id = $1', [event.eventId]);
    expect(rows[0].status).toBe('expired');
  });

  it('un snapshot retrasado no reabre un evento cancelado', async () => {
    const event = eventSnapshot({ version: 1 });
    await run('event.published', event);
    await run('event.cancelled', { eventId: event.eventId, version: 2, cancelledAt: new Date().toISOString() });
    await run('event.updated', { ...event, version: 3, status: 'published' });
    const { rows } = await pool.query('SELECT status FROM event_projection WHERE event_id = $1', [event.eventId]);
    expect(rows[0].status).toBe('cancelled');
  });

  it('una orden aprobada después de cancelar el evento no emite pases ni suma cupo', async () => {
    const event = eventSnapshot({ ticketed: true, priceCents: 1000, version: 1 });
    await run('event.published', event);
    await run('event.cancelled', { eventId: event.eventId, version: 2, cancelledAt: new Date().toISOString() });
    const order = {
      orderId: crypto.randomUUID(), eventId: event.eventId, organizerId: ORGANIZER, buyerId: BUYER, quantity: 2,
      unitPriceCents: 1000, subtotalCents: 2000, commissionCents: 160, totalCents: 2160, currency: 'COP',
      paymentMethod: 'NEQUI', providerTransactionId: 'tx', approvedAt: new Date().toISOString(),
    };
    await expect(run('order.approved', order)).rejects.toThrow(/requiere compensación/);
    const { rows } = await pool.query('SELECT attendee_count FROM event_projection WHERE event_id = $1', [event.eventId]);
    expect(rows[0].attendee_count).toBe(0);
    const { rowCount } = await pool.query('SELECT 1 FROM attendances WHERE order_id = $1', [order.orderId]);
    expect(rowCount).toBe(0);
  });

  // event-service ordena los conteos por confirmedAt / cancelledAt: si la hora se fijara antes de tener el
  // candado del evento, una transacción que lo esperó publicaría el conteo más nuevo con una hora más vieja.
  describe('la hora de confirmar y cancelar es posterior al candado del evento', () => {
    /**
     * Espera a que `waiters` conexiones queden esperando el candado de fila (no basta con dejar pasar tiempo).
     * La primera espera a quien retiene el evento; las siguientes, a la que está antes en la fila, así que se
     * cuenta cualquier espera cuya cadena de bloqueo llegue a `holderPid`.
     */
    async function untilSomeoneWaits(holderPid, waiters = 1) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const { rowCount } = await pool.query(
          `WITH RECURSIVE chain AS (
             SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))
             UNION
             SELECT a.pid FROM pg_stat_activity a JOIN chain c ON c.pid = ANY(pg_blocking_pids(a.pid))
             WHERE a.wait_event_type = 'Lock'
           )
           SELECT pid FROM chain`,
          [holderPid],
        );
        if (rowCount >= waiters) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('ninguna consulta llegó a esperar el candado del evento');
    }

    /** Retiene el evento con FOR UPDATE, lanza la acción, espera a que quede bloqueada y libera. */
    async function whileLocked(eventId, action) {
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM event_projection WHERE event_id = $1 FOR UPDATE', [eventId]);
        const { rows: me } = await holder.query('SELECT pg_backend_pid() AS pid');
        const pending = action();
        pending.catch(() => {}); // el error, si lo hay, se ve en el await de abajo
        await untilSomeoneWaits(me[0].pid);
        const { rows } = await holder.query('SELECT clock_timestamp() AS t');
        await holder.query('COMMIT');
        return { result: await pending, releasedAt: rows[0].t.getTime() };
      } finally {
        holder.release();
      }
    }

    /**
     * Como whileLocked, pero con varias acciones que quedan en fila esperando el candado, en el orden dado:
     * cada una se lanza cuando la anterior ya está esperando. PostgreSQL entrega el candado en ese orden.
     */
    async function whileLockedInOrder(eventId, actions) {
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM event_projection WHERE event_id = $1 FOR UPDATE', [eventId]);
        const { rows: me } = await holder.query('SELECT pg_backend_pid() AS pid');
        const pending = [];
        for (const [i, action] of actions.entries()) {
          const p = action();
          p.catch(() => {});
          pending.push(p);
          await untilSomeoneWaits(me[0].pid, i + 1);
        }
        await holder.query('COMMIT');
        return await Promise.all(pending);
      } finally {
        holder.release();
      }
    }

    const cancelledOf = async (attendanceId) =>
      (await outbox('attendance.cancelled')).find((m) => m.attendanceId === attendanceId);

    it('RSVP: confirmar y cancelar', async () => {
      const event = eventSnapshot();
      await run('event.published', event);

      const confirmed = await whileLocked(event.eventId, () => attendance.confirmAttendance(event.eventId, STRANGER, null));
      expect(confirmed.result.outcome).toBe('confirmed');
      const confirmMsg = (await outbox('attendance.confirmed')).find((m) => m.eventId === event.eventId && m.userId === STRANGER);
      expect(new Date(confirmMsg.confirmedAt).getTime()).toBeGreaterThanOrEqual(confirmed.releasedAt);

      const cancelled = await whileLocked(event.eventId, () => attendance.cancelAttendance(event.eventId, STRANGER, null));
      expect(cancelled.result.outcome).toBe('cancelled');
      const cancelMsg = await cancelledOf(confirmed.result.attendance.attendanceId);
      expect(new Date(cancelMsg.cancelledAt).getTime()).toBeGreaterThanOrEqual(cancelled.releasedAt);
    });

    it('order.refunded', async () => {
      const event = eventSnapshot({ ticketed: true, priceCents: 1000 });
      await run('event.published', event);
      const order = {
        orderId: crypto.randomUUID(), eventId: event.eventId, organizerId: ORGANIZER, buyerId: BUYER, quantity: 1,
        unitPriceCents: 1000, subtotalCents: 1000, commissionCents: 80, totalCents: 1080, currency: 'COP',
        paymentMethod: 'NEQUI', providerTransactionId: 'tx', approvedAt: new Date().toISOString(),
      };
      await run('order.approved', order);
      const { rows } = await pool.query('SELECT id FROM attendances WHERE order_id = $1', [order.orderId]);

      const refund = { orderId: order.orderId, eventId: event.eventId, buyerId: BUYER, amountCents: 1080, refundedBy: ORGANIZER, refundedAt: new Date().toISOString() };
      const { releasedAt } = await whileLocked(event.eventId, () => run('order.refunded', refund));
      const cancelMsg = await cancelledOf(rows[0].id);
      expect(cancelMsg).toMatchObject({ reason: 'refunded', attendeeCount: 0 });
      expect(new Date(cancelMsg.cancelledAt).getTime()).toBeGreaterThanOrEqual(releasedAt);
    });

    it('account.deleted', async () => {
      const event = eventSnapshot();
      await run('event.published', event);
      const userId = crypto.randomUUID();
      const confirmed = await attendance.confirmAttendance(event.eventId, userId, null);

      const { releasedAt } = await whileLocked(event.eventId, () => run('account.deleted', { userId, deletedAt: new Date().toISOString() }));
      const cancelMsg = await cancelledOf(confirmed.attendance.attendanceId);
      expect(cancelMsg).toMatchObject({ reason: 'account_deleted', attendeeCount: 0 });
      expect(new Date(cancelMsg.cancelledAt).getTime()).toBeGreaterThanOrEqual(releasedAt);
    });

    it('event.cancelled y account.deleted a la vez sobre la misma asistencia: se anula una sola vez', async () => {
      const event = eventSnapshot();
      await run('event.published', event);
      const userId = crypto.randomUUID();
      const confirmed = await attendance.confirmAttendance(event.eventId, userId, null);
      const attendanceId = confirmed.attendance.attendanceId;

      // Los dos leen la asistencia como confirmada mientras el evento está retenido; event.cancelled
      // queda primero en la fila del candado, así que account.deleted llega cuando ya está anulada.
      await whileLockedInOrder(event.eventId, [
        () => run('event.cancelled', { eventId: event.eventId, version: 2, cancelledAt: new Date().toISOString() }),
        () => run('account.deleted', { userId, deletedAt: new Date().toISOString() }),
      ]);

      const messages = (await outbox('attendance.cancelled')).filter((m) => m.attendanceId === attendanceId);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ reason: 'event_cancelled', attendeeCount: 0 });
      const { rows } = await pool.query('SELECT attendee_count FROM event_projection WHERE event_id = $1', [event.eventId]);
      expect(rows[0].attendee_count).toBe(0);
    });
  });
});
