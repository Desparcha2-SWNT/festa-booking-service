// El `version` del sobre es la versión del esquema de `data` (x-version del catálogo, ver
// envelope.schema.json). attendance.* pasó a x-version 2 con festa-infra#19: el publicador ya no puede
// fijar 1 para todos los mensajes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), release: vi.fn() }));
vi.mock('../../src/db/pool.js', () => ({ pool: { connect: h.connect } }));

const { getSchemaRegistry, _resetForTests } = await import('../../src/messaging/schemaRegistry.js');
const { startOutboxPublisher } = await import('../../src/messaging/outboxPublisher.js');

const contractsDir = process.env.FESTA_CONTRACTS_DIR ?? path.resolve('../festa-infra/contracts');
const hasContracts = fs.existsSync(path.join(contractsDir, 'envelope.schema.json'));

/** El x-version que declara el archivo de esquema, leído directo del catálogo. */
const schemaVersion = (name) =>
  JSON.parse(fs.readFileSync(path.join(contractsDir, `events/booking/${name}.schema.json`), 'utf8'))['x-version'];

describe.skipIf(!hasContracts)('version del sobre = x-version del esquema', () => {
  beforeAll(() => _resetForTests());

  it('el registro expone el x-version de cada routing key y 1 si no hay esquema', () => {
    const registry = getSchemaRegistry(contractsDir);
    expect(registry.getVersion('attendance.confirmed')).toBe(schemaVersion('attendance.confirmed'));
    expect(registry.getVersion('attendance.cancelled')).toBe(schemaVersion('attendance.cancelled'));
    expect(registry.getVersion('pass.checked_in')).toBe(schemaVersion('pass.checked_in'));
    expect(registry.getVersion('no.existe')).toBe(1);
  });

  it('el publicador pone en el sobre el x-version de cada mensaje, no un 1 fijo', async () => {
    const row = (routingKey) => ({
      id: routingKey,
      event_id: crypto.randomUUID(),
      created_at: new Date('2026-11-20T10:00:00Z'),
      correlation_id: null,
      causation_id: null,
      exchange: 'festa.booking',
      routing_key: routingKey,
      payload: {},
    });
    const rows = [row('attendance.confirmed'), row('attendance.cancelled'), row('pass.checked_in')];
    h.connect.mockResolvedValue({ query: h.query, release: h.release });
    h.query.mockImplementation(async (sql) => (String(sql).includes('SELECT id') ? { rows } : { rows: [] }));

    const published = [];
    const channel = {
      publish: vi.fn((_exchange, _key, content, _options, done) => {
        published.push(JSON.parse(content.toString()));
        done();
      }),
    };
    const publisher = startOutboxPublisher({ createConfirmChannel: vi.fn().mockResolvedValue(channel) }, { intervalMs: 60_000 });
    try {
      await vi.waitFor(() => expect(published).toHaveLength(3));
    } finally {
      publisher.stop();
    }

    const versionOf = (type) => published.find((e) => e.eventType === type).version;
    expect(versionOf('attendance.confirmed')).toBe(schemaVersion('attendance.confirmed'));
    expect(versionOf('attendance.cancelled')).toBe(schemaVersion('attendance.cancelled'));
    expect(versionOf('pass.checked_in')).toBe(schemaVersion('pass.checked_in'));
  });
});
