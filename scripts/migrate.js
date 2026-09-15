// Aplica las migraciones de `api-vehiculos` en orden alfabético.
//
// Uso:
//   node scripts/migrate.js            # aplica todas las migraciones .sql
//   DB_* por entorno (mismo .env del servicio). En host: DB_HOST=127.0.0.1.
//
// Idempotente: las migraciones usan CREATE TABLE IF NOT EXISTS. El runner
// registra lo aplicado en `schema_migrations` para trazabilidad.
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || 'api_vehiculos',
    user: process.env.DB_USER || 'bit',
    password: process.env.DB_PASSWORD || 'bit',
    multipleStatements: true,
    waitForConnections: true,
    connectionLimit: 2,
  });

  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id INT PRIMARY KEY AUTO_INCREMENT,
         archivo VARCHAR(255) NOT NULL,
         applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
         UNIQUE KEY uq_schema_migrations_archivo (archivo)
       )`,
    );
    const [aplicadas] = await pool.query(`SELECT archivo FROM schema_migrations`);
    const yaAplicadas = new Set(aplicadas.map((r) => r.archivo));

    const archivos = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let aplicadasAhora = 0;
    for (const archivo of archivos) {
      if (yaAplicadas.has(archivo)) {
        console.log(`[migrate] skip ${archivo} (ya aplicada)`);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, archivo), 'utf8');
      console.log(`[migrate] aplicando ${archivo} ...`);
      await pool.query(sql);
      await pool.query(`INSERT INTO schema_migrations (archivo) VALUES (?)`, [archivo]);
      aplicadasAhora++;
    }
    console.log(`[migrate] listo: ${aplicadasAhora} migración(es) aplicada(s), ${archivos.length} total.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`[migrate] error: ${err.message}`);
  process.exit(1);
});
