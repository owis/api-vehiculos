import mysql from 'mysql2/promise';
import { env } from '../config/index.js';

// Pool MySQL del servicio (BD propia `api_vehiculos`).
// Mismo patrón que bit/api: namedPlaceholders + dateStrings.
export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  database: env.db.name,
  user: env.db.user,
  password: env.db.password,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  namedPlaceholders: true,
  dateStrings: true,
});

export async function query(sql, params = {}) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

export async function queryOne(sql, params = {}) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

export async function execute(sql, params = {}) {
  const [result] = await pool.execute(sql, params);
  return result;
}
