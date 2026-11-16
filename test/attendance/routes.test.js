// SCRUM-71: qué responde cada resultado de la API de asistencia.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { jwtPrivateKeyPem } from '../fixtures/jwtKeys.js';

const repo = vi.hoisted(() => ({
  confirmAttendance: vi.fn(),
  cancelAttendance: vi.fn(),
  getAttendanceStatus: vi.fn(),
}));

vi.mock('../../src/attendance/repository.js', () => repo);

const { createApp } = await import('../../src/app.js');

const EVENT_ID = '6f1c2b8e-3a1d-4c3e-9b0a-1f2e3d4c5b6a';
const USER_ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const URL = `/bookings/events/${EVENT_ID}/attendance`;

const token = jwt.sign({ role: 'user' }, jwtPrivateKeyPem, {
  algorithm: 'RS256',
  issuer: process.env.JWT_ISSUER,
  subject: USER_ID,
  expiresIn: '15m',
});
const auth = (req) => req.set('Authorization', `Bearer ${token}`);
const attendance = { attendanceId: 'a', eventId: EVENT_ID, status: 'confirmed', passIds: ['p'], attendeeCount: 1 };

beforeEach(() => vi.clearAllMocks());

describe('autenticación y validación', () => {
  it.each(['post', 'delete', 'get'])('%s rechaza sin token', async (method) => {
    const res = await request(createApp())[method](URL);
    expect(res.status).toBe(401);
  });

  it('rechaza un id que no es uuid', async () => {
    const res = await auth(request(createApp()).post('/bookings/events/nope/attendance'));
    expect(res.status).toBe(400);
    expect(repo.confirmAttendance).not.toHaveBeenCalled();
  });
});

describe('POST confirmar', () => {
  it('da 201 al confirmar, con el usuario del token', async () => {
    repo.confirmAttendance.mockResolvedValue({ outcome: 'confirmed', attendance });
    const res = await auth(request(createApp()).post(URL));

    expect(res.status).toBe(201);
    expect(res.body).toEqual(attendance);
    expect(repo.confirmAttendance).toHaveBeenCalledWith(EVENT_ID, USER_ID, null);
  });

  it('da 200 si ya estaba confirmada', async () => {
    repo.confirmAttendance.mockResolvedValue({ outcome: 'already_confirmed', attendance });
    const res = await auth(request(createApp()).post(URL));
    expect(res.status).toBe(200);
  });

  it.each([
    ['not_found', 404],
    ['closed', 409],
    ['requires_ticket', 409],
    ['full', 409],
  ])('%s da %i con su código', async (outcome, status) => {
    repo.confirmAttendance.mockResolvedValue({ outcome });
    const res = await auth(request(createApp()).post(URL));

    expect(res.status).toBe(status);
    expect(res.body.code).toBe(outcome);
  });
});

describe('DELETE cancelar', () => {
  it('da 200 con el conteo nuevo', async () => {
    repo.cancelAttendance.mockResolvedValue({ outcome: 'cancelled', attendeeCount: 4 });
    const res = await auth(request(createApp()).delete(URL));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ eventId: EVENT_ID, status: 'cancelled', attendeeCount: 4 });
  });

  it.each([
    ['not_found', 404],
    ['not_attending', 404],
    ['closed', 409],
  ])('%s da %i', async (outcome, status) => {
    repo.cancelAttendance.mockResolvedValue({ outcome });
    const res = await auth(request(createApp()).delete(URL));
    expect(res.status).toBe(status);
  });
});

describe('GET estado', () => {
  it('devuelve conteo y estado del usuario', async () => {
    repo.getAttendanceStatus.mockResolvedValue({ eventId: EVENT_ID, capacity: 10, attendeeCount: 3, confirmed: false });
    const res = await auth(request(createApp()).get(URL));

    expect(res.status).toBe(200);
    expect(res.body.attendeeCount).toBe(3);
  });

  it('da 404 si el evento no existe', async () => {
    repo.getAttendanceStatus.mockResolvedValue(null);
    const res = await auth(request(createApp()).get(URL));
    expect(res.status).toBe(404);
  });
});
