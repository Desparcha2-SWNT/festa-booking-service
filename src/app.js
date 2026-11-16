import express from 'express';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';

export function createApp({ trustProxy = config.trustProxy } = {}) {
  const app = express();
  // Detrás de Kong: sin esto, req.ip sería la IP de Kong y no la del cliente.
  app.set('trust proxy', trustProxy);
  app.use(pinoHttp({ logger }));
  app.use(express.json());

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.use((err, req, res, _next) => {
    req.log.error(err);
    res.status(500).json({ error: 'error interno' });
  });

  return app;
}
