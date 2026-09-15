import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/index.js';

// REQ: PRT Local Lookup PR1 — schema inicial (tasks 1.1, 1.2).
//
// Schema-only work unit: global `prt_revision` table (no empresa_id),
// UNIQUE(ppu, num_certificado), PPU index. El servicio es autónomo
// (BD `api_vehiculos`); behavioral assertions use real upserts against it;
// rows are namespaced by MARK and cleaned up.

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION_SCHEMA = resolve(__dirname, '..', 'migrations', '001_schema.sql');

const MARK = `Q${Date.now().toString(36).slice(-3).toUpperCase()}${Math.floor(Math.random() * 1296)
  .toString(36)
  .toUpperCase()
  .padStart(2, '0')}`;
const PPU_DUP = `${MARK}D1`;
const PPU_MULTI = `${MARK}M1`;

async function q(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}
async function q1(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows[0] ?? null;
}

before(async () => {
  await q(`DELETE FROM prt_revision WHERE ppu LIKE ?`, [`${MARK}%`]).catch(() => {});
});

after(async () => {
  try {
    await q(`DELETE FROM prt_revision WHERE ppu LIKE ?`, [`${MARK}%`]).catch(() => {});
  } finally {
    await pool.end();
  }
});

test('schema file exists and creates the global prt_revision table', () => {
  assert.ok(existsSync(MIGRACION_SCHEMA), 'api-vehiculos/migrations/001_schema.sql must exist');
  const sql = readFileSync(MIGRACION_SCHEMA, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS `prt_revision`/i, 'must create prt_revision');
  assert.doesNotMatch(sql, /`empresa_id`/, 'prt_revision must be global (no empresa_id column)');
});

test('schema enforces UK on (ppu, num_certificado) and a ppu index', () => {
  const sql = readFileSync(MIGRACION_SCHEMA, 'utf8');
  assert.match(
    sql,
    /UNIQUE KEY `uq_prt_ppu_cert` \(`ppu`, `num_certificado`\)/i,
    'must enforce UNIQUE(ppu, num_certificado)',
  );
  assert.match(sql, /INDEX `idx_prt_ppu` \(`ppu`\)/i, 'must index ppu for latest-revision lookup');
});

test('api_vehiculos carries prt_revision with the UK and the ppu index', async () => {
  const table = await q1(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prt_revision'`,
  );
  assert.ok(table, 'schema migration must be applied: table prt_revision does not exist');
  const uk = await q1(
    `SELECT CONSTRAINT_NAME AS c FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prt_revision'
       AND CONSTRAINT_TYPE = 'UNIQUE' AND CONSTRAINT_NAME = 'uq_prt_ppu_cert'`,
  );
  assert.ok(uk, 'uq_prt_ppu_cert unique constraint must exist on prt_revision');
  const ukCols = await q(
    `SELECT COLUMN_NAME AS c FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prt_revision'
       AND INDEX_NAME = 'uq_prt_ppu_cert' ORDER BY SEQ_IN_INDEX`,
  );
  assert.deepEqual(
    ukCols.map((r) => r.c),
    ['ppu', 'num_certificado'],
    'uq_prt_ppu_cert must cover exactly (ppu, num_certificado)',
  );
  const idx = await q1(
    `SELECT INDEX_NAME AS i FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prt_revision' AND INDEX_NAME = 'idx_prt_ppu'`,
  );
  assert.ok(idx, 'idx_prt_ppu index must exist on prt_revision');
});

test('Duplicate certificate upsert: same (ppu, num_certificado) updates without duplicating', async () => {
  await q(
    `INSERT INTO prt_revision (ppu, num_certificado, periodo, marca, kilometraje, fec_revision)
     VALUES (?, 'CERT-1', '202601', 'Toyota', 50000, '2026-01-10')
     ON DUPLICATE KEY UPDATE marca = VALUES(marca), kilometraje = VALUES(kilometraje)`,
    [PPU_DUP],
  );
  await q(
    `INSERT INTO prt_revision (ppu, num_certificado, periodo, marca, kilometraje, fec_revision)
     VALUES (?, 'CERT-1', '202601', 'Toyota', 95000, '2026-01-10')
     ON DUPLICATE KEY UPDATE marca = VALUES(marca), kilometraje = VALUES(kilometraje)`,
    [PPU_DUP],
  );
  const rows = await q(`SELECT kilometraje FROM prt_revision WHERE ppu = ?`, [PPU_DUP]);
  assert.equal(rows.length, 1, 're-ingest of the same certificate must not create a duplicate row');
  assert.equal(rows[0].kilometraje, 95000, 're-ingest must update the existing row');
});

test('Latest revision lookup: greatest fec_revision wins for one ppu', async () => {
  for (const [cert, fecha, km] of [
    ['CERT-OLD', '2025-12-05', 40000],
    ['CERT-NEW', '2026-01-15', 95000],
    ['CERT-MID', '2026-01-02', 80000],
  ]) {
    await q(
      `INSERT INTO prt_revision (ppu, num_certificado, periodo, marca, kilometraje, fec_revision)
       VALUES (?, ?, '202601', 'Toyota', ?, ?)`,
      [PPU_MULTI, cert, km, fecha],
    );
  }
  const latest = await q1(
    `SELECT num_certificado AS cert, kilometraje AS km FROM prt_revision
     WHERE ppu = ? ORDER BY fec_revision DESC LIMIT 1`,
    [PPU_MULTI],
  );
  assert.equal(latest.cert, 'CERT-NEW', 'latest lookup must return the row with the greatest fec_revision');
  assert.equal(latest.km, 95000, 'latest lookup must carry that row kilometraje');
});
