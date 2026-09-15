import { HttpError } from '../middleware/errors.js';
import * as prt from '../services/prt.service.js';
import * as resolucion from '../services/resolucion.service.js';

// Endpoints de consulta vehicular. Todos delegan en servicios sin estado.

export async function resolverHandler(req, res, next) {
  try {
    const ppu = req.params.ppu || req.query.patente || req.body?.patente;
    const force = String(req.query.force || '').toLowerCase() === 'true';
    const result = await resolucion.resolverPatente(ppu, { force });
    return res.status(200).json(result);
  } catch (err) { next(err); }
}

export async function lookupLocalHandler(req, res, next) {
  try {
    const result = await resolucion.lookupLocal(req.params.ppu);
    return res.status(200).json(result);
  } catch (err) { next(err); }
}

export async function revisionesHandler(req, res, next) {
  try {
    const revisiones = await prt.getRevisiones(req.params.ppu);
    return res.status(200).json({ revisiones });
  } catch (err) { next(err); }
}

// Guardado explícito de la caché. bit lo llama al persistir el vehículo.
export async function guardarConsultaHandler(req, res, next) {
  try {
    const body = req.body || {};
    if (!body.patente && !body.patenteNormalizada && !body.patente_normalizada) {
      throw new HttpError(422, 'patente_requerida');
    }
    const result = await resolucion.guardarConsulta(body);
    return res.status(200).json(result);
  } catch (err) { next(err); }
}
