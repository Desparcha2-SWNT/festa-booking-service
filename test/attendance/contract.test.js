// Lo que publica este servicio debe cumplir los esquemas reales de festa-infra.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const h = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock('../../src/db/pool.js', () => ({ pool: {}, withTransaction: vi.fn() }));
vi.mock('../../src/messaging/outboxRepository.js', () => ({ enqueue: h.enqueue }));

const { revokeAttendance, toConfirmedMessage } = await import('../../src/attendance/repository.js');

const contractsDir = process.env.FESTA_CONTRACTS_DIR ?? path.resolve('../festa-infra/contracts');
const schemaFile = (name) => path.join(contractsDir, `events/booking/${name}.schema.json`);

function validator(name) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(JSON.parse(fs.readFileSync(schemaFile(name), 'utf8')));
}

const EVENT_ID = '6f1c2b8e-3a1d-4c3e-9b0a-1f2e3d4c5b6a';
const USER_ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const ATTENDANCE_ID = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f7a';
const PASS_ID = 'f6a7b8c9-d0e1-4f2a-8b3c-4d5e6f7a8b9c';

describe.skipIf(!fs.existsSync(schemaFile('attendance.confirmed')))('contratos de asistencia', () => {
  it('attendance.confirmed valida contra el esquema', () => {
    const validate = validator('attendance.confirmed');
    validate(
      toConfirmedMessage(
        { event_id: EVENT_ID, title: 'Noche de jazz', starts_at: new Date('2099-01-01T01:00:00Z') },
        { id: ATTENDANCE_ID, pass_ids: [PASS_ID], confirmed_at: new Date('2026-11-10T15:00:00Z') },
        USER_ID,
        1,
      ),
    );
    expect(validate.errors, JSON.stringify(validate.errors, null, 2)).toBeNull();
  });

  it.each(['user', 'event_cancelled', 'account_deleted'])('attendance.cancelled (%s) valida contra el esquema', async (reason) => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ cancelled_at: new Date('2026-11-10T15:00:00Z') }] })
        .mockResolvedValueOnce({ rows: [{ id: PASS_ID }] })
        .mockResolvedValueOnce({ rows: [{ attendee_count: 0 }] }),
    };
    h.enqueue.mockClear();
    await revokeAttendance(client, { attendanceId: ATTENDANCE_ID, eventId: EVENT_ID, userId: USER_ID, reason });

    const validate = validator('attendance.cancelled');
    validate(h.enqueue.mock.calls[0][1].payload);
    expect(validate.errors, JSON.stringify(validate.errors, null, 2)).toBeNull();
  });
});
