import { start } from './app.js';

try {
  start();
} catch (err) {
  console.error('[api-vehiculos] error fatal al iniciar:', err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[api-vehiculos] recibido ${signal}, cerrando...`);
    process.exit(0);
  });
}
