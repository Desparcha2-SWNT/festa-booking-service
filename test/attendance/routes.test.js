// SCRUM-71: qué responde cada resultado de la API de asistencia.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { jwtPrivateKeyPem } from '../fixtures/jwtKeys.js';

const repo = vi.hoisted(() => ({
  confirmAttendance: vi.fn(),
  cancelAttendance: vi.fn(),
  getAttendanceStatus: vi.fn(),
  listMyPlans: vi.fn(),
  listAttendees: vi.fn(),
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

describe('GET lista de asistentes (SCRUM-141)', () => {
  const LIST_URL = `/bookings/events/${EVENT_ID}/attendees`;
  const list = { eventId: EVENT_ID, capacity: 80, attendeeCount: 1, total: 1, limit: 50, offset: 0, items: [] };

  it('rechaza sin token', async () => {
    const res = await request(createApp()).get(LIST_URL);
    expect(res.status).toBe(401);
  });

  it('pide la primera página de 50 por defecto, con el usuario y el rol del token', async () => {
    repo.listAttendees.mockResolvedValue({ outcome: 'ok', list });
    const res = await auth(request(createApp()).get(LIST_URL));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(list);
    expect(repo.listAttendees).toHaveBeenCalledWith(EVENT_ID, USER_ID, 'user', { limit: 50, offset: 0 });
  });

  it('pasa la paginación de la consulta', async () => {
    repo.listAttendees.mockResolvedValue({ outcome: 'ok', list });
    await auth(request(createApp()).get(`${LIST_URL}?limit=20&offset=40`));
    expect(repo.listAttendees).toHaveBeenCalledWith(EVENT_ID, USER_ID, 'user', { limit: 20, offset: 40 });
  });

  it.each(['limit=0', 'limit=201', 'offset=-1', 'limit=abc'])('rechaza %s', async (query) => {
    const res = await auth(request(createApp()).get(`${LIST_URL}?${query}`));
    expect(res.status).toBe(400);
    expect(repo.listAttendees).not.toHaveBeenCalled();
  });

  it('da 403 a quien no organiza el evento', async () => {
    repo.listAttendees.mockResolvedValue({ outcome: 'forbidden' });
    const res = await auth(request(createApp()).get(LIST_URL));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_organizer');
  });

  it('da 404 si el evento no existe', async () => {
    repo.listAttendees.mockResolvedValue({ outcome: 'not_found' });
    const res = await auth(request(createApp()).get(LIST_URL));
    expect(res.status).toBe(404);
  });
});

describe('GET mis planes (SCRUM-142)', () => {
  const PLANS = '/bookings/attendances/mine';
  const page = { when: 'upcoming', total: 0, limit: 20, offset: 0, items: [] };

  it('rechaza sin token', async () => {
    const res = await request(createApp()).get(PLANS);
    expect(res.status).toBe(401);
  });

  it('por defecto pide los próximos, 20 por página, del usuario del token', async () => {
    repo.listMyPlans.mockResolvedValue(page);
    const res = await auth(request(createApp()).get(PLANS));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(page);
    expect(repo.listMyPlans).toHaveBeenCalledWith(USER_ID, { when: 'upcoming', limit: 20, offset: 0 });
  });

  it('pasa la pestaña y la página pedidas', async () => {
    repo.listMyPlans.mockResolvedValue({ ...page, when: 'past', offset: 40 });
    const res = await auth(request(createApp()).get(`${PLANS}?when=past&limit=10&offset=40`));

    expect(res.status).toBe(200);
    expect(repo.listMyPlans).toHaveBeenCalledWith(USER_ID, { when: 'past', limit: 10, offset: 40 });
  });

  it.each(['when=all', 'limit=0', 'limit=101', 'offset=-1', 'limit=abc'])('da 400 con %s', async (qs) => {
    const res = await auth(request(createApp()).get(`${PLANS}?${qs}`));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_query');
    expect(repo.listMyPlans).not.toHaveBeenCalled();
  });
});
