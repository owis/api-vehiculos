import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/index.js';
import { vehiculoRouter } from './routes/vehiculo.routes.js';
import { errorHandler, notFound } from './middleware/errors.js';

const app = express();

app.use(helmet());
if (env.corsOrigin.length) {
  app.use(cors({ origin: env.corsOrigin, credentials: false }));
}
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'api-vehiculos', version: '0.1.0' });
});

app.use('/vehiculos', vehiculoRouter);

app.use(notFound);
app.use(errorHandler);

export function start() {
  app.listen(env.port, () => {
    console.log(`[api-vehiculos] escuchando en http://localhost:${env.port} (${env.nodeEnv})`);
  });
}

export default app;
