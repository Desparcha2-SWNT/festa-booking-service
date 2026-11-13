import express from 'express';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { attendanceRouter } from './attendance/routes.js';
import { passesRouter } from './passes/routes.js';
import { countRequests, registry } from './metrics.js';

export function createApp({ trustProxy = config.trustProxy } = {}) {
  const app = express();
  // Detrás de Kong: sin esto, req.ip sería la IP de Kong y no la del cliente.
  app.set('trust proxy', trustProxy);
  app.use(pinoHttp({ logger }));
  app.use(express.json());
  app.use(countRequests);

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  });
  // El cliente llama a /api/bookings; Kong quita el "/api" antes de reenviar.
  app.use('/bookings', attendanceRouter);
  app.use('/bookings', passesRouter);

  app.use((err, req, res, _next) => {
    req.log.error(err);
    res.status(500).json({ error: 'error interno' });
  });

  return app;
}
