import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { cancelAttendance, confirmAttendance, getAttendanceStatus } from './repository.js';

export const attendanceRouter = Router();

// Kong ya limita por usuario; este segundo límite, por IP, no depende de pasar por el gateway.
attendanceRouter.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

const ERRORS = {
  not_found: [404, 'evento no encontrado'],
  not_attending: [404, 'no tienes asistencia confirmada en este evento'],
  closed: [409, 'el evento ya no admite este cambio de asistencia'],
  requires_ticket: [409, 'este evento requiere comprar una entrada'],
  full: [409, 'el evento no tiene cupos disponibles'],
};

function sendError(res, outcome) {
  const [status, error] = ERRORS[outcome];
  return res.status(status).json({ error, code: outcome });
}

function requireEventId(req, res, next) {
  if (!z.uuid().safeParse(req.params.id).success) return res.status(400).json({ error: 'id inválido' });
  next();
}

const handlers = [requireAuth, requireEventId];

attendanceRouter.post('/events/:id/attendance', handlers, async (req, res, next) => {
  try {
    const correlationId = req.headers['x-correlation-id'] ?? null;
    const result = await confirmAttendance(req.params.id, req.auth.userId, correlationId);
    if (!result.attendance) return sendError(res, result.outcome);
    res.status(result.outcome === 'confirmed' ? 201 : 200).json(result.attendance);
  } catch (err) {
    next(err);
  }
});

attendanceRouter.delete('/events/:id/attendance', handlers, async (req, res, next) => {
  try {
    const correlationId = req.headers['x-correlation-id'] ?? null;
    const result = await cancelAttendance(req.params.id, req.auth.userId, correlationId);
    if (result.outcome !== 'cancelled') return sendError(res, result.outcome);
    res.json({ eventId: req.params.id, status: 'cancelled', attendeeCount: result.attendeeCount });
  } catch (err) {
    next(err);
  }
});

attendanceRouter.get('/events/:id/attendance', handlers, async (req, res, next) => {
  try {
    const status = await getAttendanceStatus(req.params.id, req.auth.userId);
    if (!status) return sendError(res, 'not_found');
    res.json(status);
  } catch (err) {
    next(err);
  }
});
