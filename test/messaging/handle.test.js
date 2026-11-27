// Prueba el despacho de handle() (sobre -> validar -> verificar productor/exchange -> validar
// data -> handler) con un canal y un registro de esquemas simulados, sin RabbitMQ ni Postgres.
import { describe, expect, it, vi } from 'vitest';
import { _internal } from '../../src/messaging/inboxConsumer.js';

function fakeChannel() {
  return { ack: vi.fn(), nack: vi.fn(), sendToQueue: vi.fn() };
}

function fakeRegistry({ validEnvelope = true, dataValidator, expectedProducer, expectedExchange } = {}) {
  const validateEnvelope = vi.fn().mockReturnValue(validEnvelope);
  validateEnvelope.errors = validEnvelope ? null : [{ message: 'sobre inválido' }];
  return {
    validateEnvelope,
    getExpectedProducer: vi.fn().mockReturnValue(expectedProducer),
    getExpectedExchange: vi.fn().mockReturnValue(expectedExchange),
    getDataValidator: vi.fn().mockReturnValue(dataValidator),
  };
}

function msgWith(envelope, exchange = 'festa.user') {
  return { content: Buffer.from(JSON.stringify(envelope)), properties: { headers: {} }, fields: { exchange } };
}

describe('handle (despacho del inbox)', () => {
  it('manda a la DLQ un mensaje que no es JSON', async () => {
    const channel = fakeChannel();
    const registry = fakeRegistry();
    const msg = { content: Buffer.from('esto no es json'), properties: { headers: {} }, fields: {} };

    await _internal.handle(channel, msg, registry);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('manda a la DLQ un sobre que no cumple envelope.schema.json', async () => {
    const channel = fakeChannel();
    const registry = fakeRegistry({ validEnvelope: false });
    const msg = msgWith({ eventType: 'merchant.verified' });

    await _internal.handle(channel, msg, registry);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
  });

  it('manda a la DLQ si el productor declarado no es el dueño real del eventType', async () => {
    const channel = fakeChannel();
    const registry = fakeRegistry({ expectedProducer: 'user-service', expectedExchange: 'festa.user' });
    const msg = msgWith({ eventId: '1', eventType: 'merchant.verified', producer: 'payment-service', data: {} });

    await _internal.handle(channel, msg, registry);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('manda a la DLQ si llegó por un exchange distinto al que declara su esquema', async () => {
    const channel = fakeChannel();
    const registry = fakeRegistry({ expectedProducer: 'user-service', expectedExchange: 'festa.user' });
    // producer correcto, pero alguien lo publicó en el exchange equivocado.
    const msg = msgWith({ eventId: '1', eventType: 'merchant.verified', producer: 'user-service', data: {} }, 'festa.auth');

    await _internal.handle(channel, msg, registry);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('manda a la DLQ si `data` no cumple su esquema', async () => {
    const channel = fakeChannel();
    const dataValidator = vi.fn().mockReturnValue(false);
    dataValidator.errors = [{ message: 'falta businessName' }];
    const registry = fakeRegistry({ expectedProducer: 'user-service', expectedExchange: 'festa.user', dataValidator });
    const msg = msgWith({ eventId: '1', eventType: 'merchant.verified', producer: 'user-service', data: {} });

    await _internal.handle(channel, msg, registry);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
  });

  it('confirma sin efecto un eventType válido sin handler todavía (p. ej. attendance.confirmed)', async () => {
    const channel = fakeChannel();
    const dataValidator = vi.fn().mockReturnValue(true);
    const registry = fakeRegistry({ expectedProducer: 'booking-service', expectedExchange: 'festa.booking', dataValidator });
    const msg = msgWith({ eventId: '1', eventType: 'attendance.confirmed', producer: 'booking-service', data: {} }, 'festa.booking');

    await _internal.handle(channel, msg, registry);

    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(channel.nack).not.toHaveBeenCalled();
  });
});

describe('handleFailure (reintentos)', () => {
  // Number('algo-raro') es NaN, y NaN >= MAX_RETRIES siempre da false: sin validar esto, un
  // x-retry-count corrupto o forjado reintentaría para siempre en vez de agotarse.
  it.each(['no-es-un-numero', -1, 'NaN', '3.5'])('manda a la DLQ si x-retry-count es inválido (%s)', async (bad) => {
    const channel = fakeChannel();
    const msg = { content: Buffer.from('{}'), properties: { headers: { 'x-retry-count': bad } } };

    await _internal.handleFailure(channel, msg, { eventType: 'merchant.verified' }, new Error('falla transitoria'));

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });

  it('reintenta normalmente con un x-retry-count válido', async () => {
    const channel = fakeChannel();
    channel.sendToQueue.mockImplementation((queue, content, options, cb) => cb(null));
    const msg = { content: Buffer.from('{}'), properties: { headers: { 'x-retry-count': 1 } } };

    await _internal.handleFailure(channel, msg, { eventType: 'merchant.verified' }, new Error('falla transitoria'));

    expect(channel.sendToQueue).toHaveBeenCalledOnce();
    expect(channel.sendToQueue.mock.calls[0][2].headers['x-retry-count']).toBe(2);
    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('manda a la DLQ si ya se agotaron los reintentos', async () => {
    const channel = fakeChannel();
    const msg = { content: Buffer.from('{}'), properties: { headers: { 'x-retry-count': 3 } } };

    await _internal.handleFailure(channel, msg, { eventType: 'merchant.verified' }, new Error('falla transitoria'));

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });
});

describe('origen de un reintento (x-origin-exchange firmado)', () => {
  // La cola booking-service.inbox.retry hace dead-letter por el exchange por defecto: el mensaje vuelve a la
  // inbox con fields.exchange vacío. Sin el origen firmado, todo reintento iba directo a la DLQ.
  async function retried(original) {
    const channel = fakeChannel();
    channel.sendToQueue.mockImplementation((queue, content, options, cb) => cb(null));
    await _internal.handleFailure(channel, original, { eventType: 'order.approved' }, new Error('falla transitoria'));
    const [, content, options] = channel.sendToQueue.mock.calls[0];
    return { content, properties: options, fields: { exchange: '' } };
  }

  it('un reintento que vuelve por el exchange por defecto conserva su exchange de origen', async () => {
    const back = await retried({ content: Buffer.from('{"a":1}'), properties: { headers: {} }, fields: { exchange: 'festa.payment' } });

    expect(_internal.originExchange(back)).toBe('festa.payment');
  });

  it('un segundo reintento conserva el origen del primero', async () => {
    const first = await retried({ content: Buffer.from('{"a":1}'), properties: { headers: {} }, fields: { exchange: 'festa.payment' } });
    const second = await retried(first);

    expect(_internal.originExchange(second)).toBe('festa.payment');
  });

  it('un origen sin firma válida cuenta como vacío', () => {
    const forged = {
      content: Buffer.from('{"a":1}'),
      properties: { headers: { 'x-origin-exchange': 'festa.payment', 'x-origin-signature': 'ab'.repeat(32) } },
      fields: { exchange: '' },
    };

    expect(_internal.originExchange(forged)).toBe('');
  });

  it('la firma no sirve para otro contenido', async () => {
    const back = await retried({ content: Buffer.from('{"a":1}'), properties: { headers: {} }, fields: { exchange: 'festa.payment' } });

    expect(_internal.originExchange({ ...back, content: Buffer.from('{"a":2}') })).toBe('');
  });

  it('handle acepta el reintento firmado y rechaza uno sin firma', async () => {
    const envelope = { eventType: 'merchant.verified', producer: 'user-service', data: {} };
    const original = { content: Buffer.from(JSON.stringify(envelope)), properties: { headers: {} }, fields: { exchange: 'festa.user' } };
    const back = await retried(original);
    const registry = fakeRegistry({ expectedProducer: 'user-service', expectedExchange: 'festa.user', dataValidator: () => false });

    const ch1 = fakeChannel();
    await _internal.handle(ch1, back, registry);
    // Pasa la comprobación del exchange y llega a la del data (que aquí falla a propósito).
    expect(registry.getDataValidator).toHaveBeenCalled();

    const ch2 = fakeChannel();
    const unsigned = { ...back, properties: { headers: { 'x-retry-count': 1 } } };
    registry.getDataValidator.mockClear();
    await _internal.handle(ch2, unsigned, registry);
    expect(ch2.nack).toHaveBeenCalledWith(unsigned, false, false);
    expect(registry.getDataValidator).not.toHaveBeenCalled();
  });
});

describe('resolveInboxRetryKey', () => {
  it.each([undefined, '', 'corta', 'change-me-por-favor-123456'])('rechaza %s', async (value) => {
    const { resolveInboxRetryKey } = await import('../../src/config.js');
    expect(() => resolveInboxRetryKey(value)).toThrow(/INBOX_RETRY_KEY/);
  });
});
