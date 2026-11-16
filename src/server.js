import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';

async function main() {
  await migrate();

  const server = createApp().listen(config.port, () => {
    logger.info({ port: config.port }, 'festa-booking-service arriba');
  });

  const shutdown = async () => {
    logger.info('apagando...');
    // server.close espera a que terminen las conexiones abiertas: se espera su callback antes de cerrar la base.
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections();
    });
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error(err, 'no se pudo arrancar el servicio');
  process.exit(1);
});
