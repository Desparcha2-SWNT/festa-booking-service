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

  describe('SCRUM-142: mis planes', () => {
    const hoursFromNow = (h) => new Date(Date.now() + h * 3600_000).toISOString();

    /** Publica un evento y confirma la asistencia del usuario mientras todavía está abierto. */
    async function attend(userId, overrides = {}) {
      const event = eventSnapshot(overrides);
      await run('event.published', event);
      expect((await attendance.confirmAttendance(event.eventId, userId, null)).outcome).toBe('confirmed');
      return event;
    }

    /** Mueve el evento al pasado con un snapshot nuevo (no se puede confirmar en uno que ya terminó). */
    async function finish(event) {
      await run('event.updated', { ...event, version: 2, startsAt: hoursFromNow(-5), endsAt: hoursFromNow(-2) });
    }

    it('separa próximos y pasados, con lugar y portada, y deja fuera lo ajeno', async () => {
      const me = crypto.randomUUID();
      const later = await attend(me, { title: 'Después', startsAt: hoursFromNow(48), endsAt: hoursFromNow(50), coverImageUrl: 'https://img.test/a.jpg' });
      const soon = await attend(me, { title: 'Pronto' });
      const old = await attend(me, { title: 'Ya fue' });
      await finish(old);

      // Lo que no debe salir: un plan que el usuario canceló, el de otra persona y una entrada paga.
      const dropped = await attend(me, { title: 'Cancelado por mí' });
      expect((await attendance.cancelAttendance(dropped.eventId, me, null)).outcome).toBe('cancelled');
      await attend(STRANGER, { title: 'De otro' });
      const paid = eventSnapshot({ ticketed: true, priceCents: 1000 });
      await run('event.published', paid);
      await run('order.approved', {
        orderId: crypto.randomUUID(), eventId: paid.eventId, organizerId: ORGANIZER, buyerId: me, quantity: 1,
        unitPriceCents: 1000, subtotalCents: 1000, commissionCents: 80, totalCents: 1080, currency: 'COP',
        paymentMethod: 'NEQUI', providerTransactionId: 'tx', approvedAt: new Date().toISOString(),
      });

      const upcoming = await attendance.listMyPlans(me, { when: 'upcoming', limit: 20, offset: 0 });
      expect(upcoming.total).toBe(2);
      expect(upcoming.items.map((p) => p.title)).toEqual(['Pronto', 'Después']);
      expect(upcoming.items[1]).toMatchObject({
        eventId: later.eventId,
        venueName: 'Bloque G',
        coverImageUrl: 'https://img.test/a.jpg',
        status: 'confirmed',
        eventStatus: 'published',
      });
      expect(upcoming.items[0].eventId).toBe(soon.eventId);
      expect(upcoming.items[0].coverImageUrl).toBeNull();

      const past = await attendance.listMyPlans(me, { when: 'past', limit: 20, offset: 0 });
      expect(past.items.map((p) => p.title)).toEqual(['Ya fue']);
    });

    it('un plan anulado porque el organizador canceló el evento sigue en pasados, marcado', async () => {
      const me = crypto.randomUUID();
      const event = await attend(me, { title: 'Se canceló' });
      // Otro plan del mismo evento que el usuario canceló antes no debe aparecer.
      expect((await attendance.cancelAttendance(event.eventId, me, null)).outcome).toBe('cancelled');
      expect((await attendance.confirmAttendance(event.eventId, me, null)).outcome).toBe('confirmed');
      await run('event.cancelled', { eventId: event.eventId, version: 2, cancelledAt: new Date().toISOString() });

      expect((await attendance.listMyPlans(me, { when: 'upcoming', limit: 20, offset: 0 })).total).toBe(0);
      const past = await attendance.listMyPlans(me, { when: 'past', limit: 20, offset: 0 });
      expect(past.total).toBe(1);
      expect(past.items[0]).toMatchObject({ eventId: event.eventId, status: 'event_cancelled', eventStatus: 'cancelled' });
    });

    it('pagina y da el total aunque la página pedida ya esté vacía', async () => {
      const me = crypto.randomUUID();
      for (const h of [3, 2, 1]) await attend(me, { startsAt: hoursFromNow(h), endsAt: hoursFromNow(h + 1) });

      const first = await attendance.listMyPlans(me, { when: 'upcoming', limit: 2, offset: 0 });
      expect(first.items).toHaveLength(2);
      expect(first.total).toBe(3);
      const second = await attendance.listMyPlans(me, { when: 'upcoming', limit: 2, offset: 2 });
      expect(second.items).toHaveLength(1);
      expect(new Set([...first.items, ...second.items].map((p) => p.eventId)).size).toBe(3);
      const beyond = await attendance.listMyPlans(me, { when: 'upcoming', limit: 2, offset: 10 });
      expect(beyond).toMatchObject({ items: [], total: 3 });
    });

    // «Mis planes» separa lo que canceló el usuario de lo que anuló el organizador al cancelar el evento con
    // `cancelled_at >= closed_at`. Eso solo es cierto si las dos operaciones toman el candado del evento ANTES de
    // fijar su hora. Se retiene el candado de la fila del evento, se lanzan las dos operaciones en un orden
    // conocido y se suelta: el orden en que quedan esperando es el orden en que lo toman.
    describe('concurrencia: cancelación del usuario frente a event.cancelled', () => {
      /** Espera a que haya `waiters` conexiones esperando un candado en esta base. */
      async function untilWaiting(waiters) {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const { rows } = await pool.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
          );
          if (rows[0].n >= waiters) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error('las operaciones no esperaron el candado del evento');
      }

      /** Retiene el candado del evento, lanza `first` y luego `second` (cada una queda esperando) y lo suelta. */
      async function race(eventId, first, second) {
        const holder = await pool.connect();
        try {
          await holder.query('BEGIN');
          await holder.query('SELECT 1 FROM event_projection WHERE event_id = $1 FOR UPDATE', [eventId]);
          const a = first();
          a.catch(() => {});
          await untilWaiting(1);
          const b = second();
          b.catch(() => {});
          await untilWaiting(2);
          await holder.query('COMMIT');
          return await Promise.all([a, b]);
        } finally {
          holder.release();
        }
      }

      const cancelEvent = (event) => () => run('event.cancelled', { eventId: event.eventId, version: 2, cancelledAt: new Date().toISOString() });
      const userCancels = (event, userId) => () => attendance.cancelAttendance(event.eventId, userId, null);
      const plans = (userId, when) => attendance.listMyPlans(userId, { when, limit: 20, offset: 0 });

      it('si el usuario cancela primero, el plan no aparece: lo canceló él, no el organizador', async () => {
        const me = crypto.randomUUID();
        const event = eventSnapshot();
        await run('event.published', event);
        expect((await attendance.confirmAttendance(event.eventId, me, null)).outcome).toBe('confirmed');

        const [userResult] = await race(event.eventId, userCancels(event, me), cancelEvent(event));
        expect(userResult.outcome).toBe('cancelled');

        expect((await plans(me, 'upcoming')).total).toBe(0);
        expect((await plans(me, 'past')).total).toBe(0);
      });

      it('si el evento se cancela primero, el plan queda en pasados como event_cancelled', async () => {
        const me = crypto.randomUUID();
        const event = eventSnapshot();
        await run('event.published', event);
        expect((await attendance.confirmAttendance(event.eventId, me, null)).outcome).toBe('confirmed');

        const [, userResult] = await race(event.eventId, cancelEvent(event), userCancels(event, me));
        expect(userResult.outcome).toBe('not_attending');

        expect((await plans(me, 'upcoming')).total).toBe(0);
        const past = await plans(me, 'past');
        expect(past.total).toBe(1);
        expect(past.items[0]).toMatchObject({ eventId: event.eventId, status: 'event_cancelled', eventStatus: 'cancelled' });
      });
    });
  });
});
