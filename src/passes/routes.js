import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { checkIn, eventAttendance, getMyPass, listMyPasses } from './repository.js';

export const passesRouter = Router();

// Escanear en la entrada de un evento lleno genera ráfagas: límite holgado por IP.
passesRouter.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));
passesRouter.use(requireAuth);

const uuid = z.uuid();
const correlation = (req) => req.headers['x-correlation-id'] ?? null;

// «Mis entradas» con su QR.
passesRouter.get('/passes/mine', async (req, res, next) => {
  try {
    res.json({ items: await listMyPasses(req.auth.userId) });
  } catch (err) {
    next(err);
  }
});

passesRouter.get('/passes/:id', async (req, res, next) => {
  if (!uuid.safeParse(req.params.id).success) return res.status(400).json({ error: 'id inválido' });
  try {
    const pass = await getMyPass(req.params.id, req.auth.userId);
    if (!pass) return res.status(404).json({ error: 'pase no encontrado' });
    res.json(pass);
  } catch (err) {
    next(err);
  }
});

const checkInSchema = z.object({ qr: z.string().min(10).max(200), eventId: z.uuid() }).strict();

const REJECTION_MESSAGES = {
  already_used: 'este QR ya se usó',
  invalid_signature: 'QR inválido',
  wrong_event: 'este QR es de otro evento',
  revoked: 'este pase fue cancelado',
  outside_window: 'el ingreso no está habilitado en este momento',
  not_organizer: 'solo el organizador puede validar ingresos',
};

// RF10: el organizador escanea el QR en la entrada.
passesRouter.post('/passes/check-in', async (req, res, next) => {
  const parsed = checkInSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'cuerpo inválido', issues: z.treeifyError(parsed.error) });
  try {
    const result = await checkIn({
      ...parsed.data,
      scannedBy: req.auth.userId,
      role: req.auth.accountType,
      correlationId: correlation(req),
    });
    if (result.outcome === 'event_not_found') return res.status(404).json({ error: 'evento no encontrado' });
    if (result.outcome === 'rejected') {
      const status = result.reason === 'not_organizer' ? 403 : 409;
      return res.status(status).json({
        valid: false,
        code: result.reason,
        error: REJECTION_MESSAGES[result.reason],
        ...(result.firstUsedAt ? { firstUsedAt: result.firstUsedAt } : {}),
      });
    }
    res.json({ valid: true, ...result.pass });
  } catch (err) {
    next(err);
  }
});

// Conteo en la puerta: pases vigentes e ingresos (solo el organizador).
passesRouter.get('/events/:id/check-ins', async (req, res, next) => {
  if (!uuid.safeParse(req.params.id).success) return res.status(400).json({ error: 'id inválido' });
  try {
    const result = await eventAttendance(req.params.id, req.auth.userId, req.auth.accountType);
    if (result.outcome === 'not_found') return res.status(404).json({ error: 'evento no encontrado' });
    if (result.outcome === 'forbidden') return res.status(403).json({ error: 'solo el organizador puede ver esto' });
    res.json(result.summary);
  } catch (err) {
    next(err);
  }
});
