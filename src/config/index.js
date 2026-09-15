import 'dotenv/config';

// Configuración del servicio de consulta vehicular.
// Servicio autónomo: su propia BD (api_vehiculos) y su propia ingesta PRT.
// No depende de bit ni del worker-sii; bit lo consume por HTTP.
export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.API_VEHICULOS_PORT || 3100),

  // API key servicio-a-servicio. bit la envía en `X-Api-Key`.
  // Vacío => el servicio rechaza todo (safe default); en dev se puede forzar
  // con API_VEHICULOS_ALLOW_ANON=true para pruebas locales.
  apiKey: process.env.API_VEHICULOS_API_KEY || '',
  allowAnon: String(process.env.API_VEHICULOS_ALLOW_ANON || 'false').toLowerCase() === 'true',

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    name: process.env.DB_NAME || 'api_vehiculos',
    user: process.env.DB_USER || 'bit',
    password: process.env.DB_PASSWORD || 'bit',
  },

  corsOrigin: (process.env.API_VEHICULOS_CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // TTL de la caché de resoluciones (días). Fila más vieja se re-consulta contra PRT.
  cacheTtlDays: Number(process.env.API_VEHICULOS_CACHE_TTL_DAYS || 30),

  prt: {
    baseUrl: process.env.PRT_BASE_URL || 'https://www.prt.cl/Descargas/docs/2026/1.Enero',
    datasets: ['RA1', 'RA2', 'RB'],
  },
};
