import { registrarConsulta } from '../services/consulta-log.service.js';

// IP real del caller: si hay proxy (cloudflared/nginx) el socket remoto es del
// proxy y la IP original viene en x-forwarded-for. Tomamos el primer valor.
function extraerIp(req) {
  const xff = req.get('x-forwarded-for');
  if (xff) {
    const primera = xff.split(',')[0]?.trim();
    if (primera) return primera;
  }
  return req.ip || req.socket?.remoteAddress || null;
}

// PPU consultada: req.params se puebla recien cuando el handler hace
// match, pero este middleware corre ANTES (a nivel router). Por eso se
// infiere del path: /:ppu, /:ppu/revisiones, /lookup-local/:ppu.
function extraerPpu(req) {
  const path = req.path || "";
  const segs = path.split("/").filter(Boolean);
  if (segs.length >= 1) {
    // /consultas y /lookup-local/:ppu
    if (segs[0] === "lookup-local" && segs[1]) return segs[1];
    if (segs[0] === "consultas") {
      return req.body?.patente || req.body?.patenteNormalizada || req.body?.patente_normalizada || null;
    }
    // primer segmento es la patente (normalizada mayusculas por el caller)
    return segs[0] || null;
  }
  return null;
}

// Loguea metadata de cada request autenticado al vehiculoRouter.
// Se registra SIEMPRE que el request pase apiKeyRequired (incluso si el handler
// luego responde 404/422/500): es auditoria de acceso, no de resultado.
export function consultaLogMiddleware(req, res, next) {
  const ip = extraerIp(req);
  const endpoint = req.route?.path || req.path || null;
  const ppu = extraerPpu(req);
  // Inyectado por apiKeyRequired.
  const apiKeyFingerprint = req.apiKeyFingerprint || null;

  // fire-and-forget: no bloquea la respuesta.
  registrarConsulta({ ip, apiKeyFingerprint, endpoint, ppu }).catch(() => {});
  return next();
}
