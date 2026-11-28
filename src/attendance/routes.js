import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { cancelAttendance, confirmAttendance, getAttendanceStatus, listAttendees, listMyPlans } from './repository.js';

export const attendanceRouter = Router();

// Kong ya limita por usuario; este segundo límite, por IP, no depende de pasar por el gateway.
attendanceRouter.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

const ERRORS = {
  not_found: [404, 'evento no encontrado'],
  not_attending: [404, 'no tienes asistencia confirmada en este evento'],
  closed: [409, 'el evento ya no admite este cambio de asistencia'],
  requires_ticket: [409, 'este evento requiere comprar una entrada'],
  full: [409, 'el evento no tiene cupos disponibles'],
  account_deleted: [403, 'la cuenta fue eliminada'],
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

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// SCRUM-141: lista de asistentes para el organizador del evento.
attendanceRouter.get('/events/:id/attendees', handlers, async (req, res, next) => {
  const page = pageSchema.safeParse(req.query);
  if (!page.success) return res.status(400).json({ error: 'paginación inválida', issues: z.treeifyError(page.error) });
  try {
    const result = await listAttendees(req.params.id, req.auth.userId, req.auth.accountType, page.data);
    if (result.outcome === 'not_found') return sendError(res, 'not_found');
    if (result.outcome === 'forbidden') {
      return res.status(403).json({ error: 'solo el organizador del evento puede ver sus asistentes', code: 'not_organizer' });
    }
    res.json(result.list);
  } catch (err) {
    next(err);
  }
});

// «Mis planes» (SCRUM-142): asistencias gratis del usuario del token, por pestaña y por páginas.
const plansQuery = z.object({
  when: z.enum(['upcoming', 'past']).default('upcoming'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

attendanceRouter.get('/attendances/mine', requireAuth, async (req, res, next) => {
  const query = plansQuery.safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: 'parámetros inválidos', code: 'invalid_query' });
  try {
    res.json(await listMyPlans(req.auth.userId, query.data));
  } catch (err) {
    next(err);
  }
});
