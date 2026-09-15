import { execute } from '../db/index.js';

// Persiste metadata de la consulta en `consulta_log` (best-effort: un error de
// escritura NUNCA rompe el request al caller).
//
// Se invoca desde el middleware consulta-log, que ya inyecta en `req` el
// fingerprint del API key y la IP. El endpoint/ppu se leen de `req`.
//
// El API key completo NUNCA viaja a esta funcion: solo su fingerprint
// (primeros/ultimos 4 chars) para trazabilidad sin exponer credenciales.
export async function registrarConsulta({ ip, apiKeyFingerprint, endpoint, ppu }) {
  try {
    await execute(
      `INSERT INTO consulta_log (ip, api_key_fingerprint, endpoint, ppu, consultado_at)
       VALUES (:ip, :apiKeyFingerprint, :endpoint, :ppu, NOW())`,
      { ip: ip ?? null, apiKeyFingerprint: apiKeyFingerprint ?? null, endpoint: endpoint ?? null, ppu: ppu ?? null },
    );
  } catch {
    // best-effort: no propagar. En un entorno productivo se enviaria a un
    // logger estructurado / metrica, pero no se silencia el request.
  }
}
