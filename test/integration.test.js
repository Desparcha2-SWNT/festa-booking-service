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
  describe('SCRUM-141: lista de asistentes para el organizador', () => {
    const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const named = (userId, displayName, minutesAgo) => ({ userId, displayName, setAt: at(minutesAgo) });
    const page = { limit: 50, offset: 0 };

    it('el organizador ve a cada asistente con su nombre, sus boletas y si ya entró', async () => {
      const event = eventSnapshot({ ticketed: true, priceCents: 1000 });
      await run('event.published', event);
      const ana = crypto.randomUUID();
      const beto = crypto.randomUUID();
      await run('account.display_name_set', named(ana, 'Ana', 60));
      await run('account.display_name_set', named(ana, 'Ana María', 30));
      // Un mensaje más viejo que llega tarde no pisa el nombre más nuevo.
      await run('account.display_name_set', named(ana, 'Ana', 60));

      const order = (buyerId, quantity) => ({
        orderId: crypto.randomUUID(), eventId: event.eventId, organizerId: ORGANIZER, buyerId, quantity,
        unitPriceCents: 1000, subtotalCents: 1000 * quantity, commissionCents: 80 * quantity, totalCents: 1080 * quantity,
        currency: 'COP', paymentMethod: 'NEQUI', providerTransactionId: 'tx', approvedAt: new Date().toISOString(),
      });
      await run('order.approved', order(ana, 2));
      await run('order.approved', order(beto, 1)); // beto aún no tiene nombre en booking
      const [anaPass] = (await passes.listMyPasses(ana)).filter((p) => p.eventId === event.eventId);
      await passes.checkIn({ qr: anaPass.qr, eventId: event.eventId, scannedBy: ORGANIZER, role: 'merchant' });

      const result = await attendance.listAttendees(event.eventId, ORGANIZER, 'merchant', page);
      expect(result.outcome).toBe('ok');
      expect(result.list).toMatchObject({ attendeeCount: 3, total: 2 });
      expect(result.list.items).toEqual([
        expect.objectContaining({ displayName: 'Ana María', source: 'ticket', tickets: 2, checkedIn: 1 }),
        expect.objectContaining({ displayName: null, source: 'ticket', tickets: 1, checkedIn: 0 }),
      ]);
      // Solo el nombre visible: el id de la persona no sale en la lista.
      expect(JSON.stringify(result.list)).not.toContain(ana);
    });

    it('otro usuario recibe forbidden; un admin sí la ve; un evento inexistente da not_found', async () => {
      const event = eventSnapshot();
      await run('event.published', event);
      await attendance.confirmAttendance(event.eventId, BUYER, null);

      expect((await attendance.listAttendees(event.eventId, STRANGER, 'merchant', page)).outcome).toBe('forbidden');
      expect((await attendance.listAttendees(event.eventId, BUYER, 'user', page)).outcome).toBe('forbidden');
      expect((await attendance.listAttendees(event.eventId, STRANGER, 'admin', page)).outcome).toBe('ok');
      expect((await attendance.listAttendees(crypto.randomUUID(), ORGANIZER, 'merchant', page)).outcome).toBe('not_found');
    });

    it('pagina en orden de confirmación y no muestra las asistencias canceladas', async () => {
      const event = eventSnapshot();
      await run('event.published', event);
      const users = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      for (const [i, userId] of users.entries()) {
        await run('account.display_name_set', named(userId, `Persona ${i}`, 10));
        await attendance.confirmAttendance(event.eventId, userId, null);
      }
      await attendance.cancelAttendance(event.eventId, users[1], null);

      const page1 = await attendance.listAttendees(event.eventId, ORGANIZER, 'merchant', { limit: 1, offset: 0 });
      const page2 = await attendance.listAttendees(event.eventId, ORGANIZER, 'merchant', { limit: 1, offset: 1 });
      const past = await attendance.listAttendees(event.eventId, ORGANIZER, 'merchant', { limit: 1, offset: 5 });
      expect(page1.list.items.map((a) => a.displayName)).toEqual(['Persona 0']);
      expect(page2.list.items.map((a) => a.displayName)).toEqual(['Persona 2']);
      expect([page1.list.total, page2.list.total, past.list.total]).toEqual([2, 2, 2]);
      expect(past.list.items).toEqual([]);
    });

    it('al borrar la cuenta se borra su nombre y un mensaje atrasado no lo recrea (Ley 1581)', async () => {
      const userId = crypto.randomUUID();
      const nameOf = async () => (await pool.query('SELECT 1 FROM user_names WHERE user_id = $1', [userId])).rowCount;
      await run('account.display_name_set', named(userId, 'Xime', 5));
      await run('account.deleted', { userId, deletedAt: new Date().toISOString() });
      expect(await nameOf()).toBe(0);

      // Llega tarde, después del borrado, un mensaje con el nombre (anterior o incluso con hora posterior).
      await run('account.display_name_set', named(userId, 'Xime', 10));
      await run('account.display_name_set', named(userId, 'Xime', -5));
      expect(await nameOf()).toBe(0);
      // Un account.deleted repetido no falla.
      await run('account.deleted', { userId, deletedAt: new Date().toISOString() });
    });

    it('el nombre y el borrado de la misma cuenta se procesan uno después del otro, aunque lleguen a la vez', async () => {
      const userId = crypto.randomUUID();
      const nameOf = async () => (await pool.query('SELECT 1 FROM user_names WHERE user_id = $1', [userId])).rowCount;

      /** Espera a que `waiters` conexiones queden esperando el candado del usuario que retiene `holderPid`. */
      async function untilWaiting(holderPid, waiters) {
        const deadline = Date.now() + 4_000;
        while (Date.now() < deadline) {
          const { rowCount } = await pool.query(
            `SELECT 1 FROM pg_stat_activity WHERE wait_event = 'advisory' AND $1 = ANY(pg_blocking_pids(pid))`,
            [holderPid],
          );
          if (rowCount >= waiters) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error('los handlers no esperaron el candado del usuario');
      }

      // Se retiene el candado del usuario y se lanzan los dos mensajes: si no lo pidieran, correrían a la
      // vez y el nombre podía quedar guardado después del borrado. Así, el que va segundo ve al primero.
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT pg_advisory_xact_lock(hashtext('booking.user_names'), hashtext($1))`, [userId]);
        const { rows: me } = await holder.query('SELECT pg_backend_pid() AS pid');
        const deleted = run('account.deleted', { userId, deletedAt: new Date().toISOString() });
        const named = run('account.display_name_set', { userId, displayName: 'Xime', setAt: new Date().toISOString() });
        deleted.catch(() => {});
        named.catch(() => {});
        await untilWaiting(me[0].pid, 2);
        await holder.query('COMMIT');
        await Promise.all([deleted, named]);
      } finally {
        holder.release();
      }

      // Sea cual sea el orden en que tomaron el candado, el nombre no queda guardado.
      expect(await nameOf()).toBe(0);
    });
  });
});
