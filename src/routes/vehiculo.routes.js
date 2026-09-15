import { Router } from 'express';
import { apiKeyRequired } from '../middleware/auth.js';
import { consultaLogMiddleware } from '../middleware/consulta-log.js';
import * as vehiculo from '../controllers/vehiculo.controller.js';

export const vehiculoRouter = Router();

// Auth primero; si falla (401/503) no se loguea (el request no es valido).
vehiculoRouter.use(apiKeyRequired);
// Auditoria de acceso: se registra siempre que pase la auth.
vehiculoRouter.use(consultaLogMiddleware);

// Rutas exactas antes de las paramétricas.
vehiculoRouter.get('/lookup-local/:ppu', vehiculo.lookupLocalHandler);
vehiculoRouter.post('/consultas', vehiculo.guardarConsultaHandler);
vehiculoRouter.get('/:ppu/revisiones', vehiculo.revisionesHandler);
vehiculoRouter.get('/:ppu', vehiculo.resolverHandler);
