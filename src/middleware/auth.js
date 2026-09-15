import { env } from '../config/index.js';

// Fingerprint de un API key: primeros 4 + ultimos 4, con *** en medio.
// Suficiente para trazabilidad; NUNCA se guarda el key completo en logs/BD.
export function fingerprintApiKey(key) {
  if (!key) return null;
  const s = String(key);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

// Auth servicio-a-servicio por API key (header `X-Api-Key`).
// Sin API_VEHICULOS_API_KEY configurada, solo pasan requests cuando
// API_VEHICULOS_ALLOW_ANON=true (dev/test). Default: fail closed.
// Inyecta `req.apiKeyFingerprint` para el middleware de auditoria.
export function apiKeyRequired(req, res, next) {
  if (env.allowAnon && !env.apiKey) {
    req.autenticado = false;
    req.apiKeyFingerprint = null;
    return next();
  }
  if (!env.apiKey) {
    return res.status(503).json({ error: 'api_key_no_configurada' });
  }
  const presented = req.get('x-api-key') || '';
  if (presented !== env.apiKey) {
    return res.status(401).json({ error: 'api_key_invalida' });
  }
  req.autenticado = true;
  req.apiKeyFingerprint = fingerprintApiKey(presented);
  return next();
}
