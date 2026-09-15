// Error HTTP con status y código de dominio. Mismo contrato que bit/api para
// que el error handler del consumidor (bit) pueda mapearlo sin traducción.
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = 'HttpError';
    this.status = status;
    this.httpStatus = status;
    this.code = code;
  }
}

export function notFound(_req, res) {
  res.status(404).json({ error: 'not_found' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  const status = err?.status || err?.httpStatus || 500;
  const code = err?.code || 'error_interno';
  if (status >= 500) {
    console.error('[api-vehiculos] error:', err?.message || err);
  }
  res.status(status).json({ error: code });
}
