import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/index.js';
import {
  buildHeaderIndex,
  mapRowToRecord,
  upsertBatch,
  mapRowToDetalle,
  toTimeOrNull,
  toDecimalOrNull,
  upsertBatchDetalle,
  checksumDetalle,
  DETALLE_COLS,
} from '../scripts/ingest-prt.js';

// REQ: vehiculo-detalle — schema detalle + backfill (tasks 1.1-1.3).
// Detalle 1:1 (46 cols RA2) con UK-upsert idempotente + checksum dual.
// Servicio autónomo: el schema vive en api-vehiculos/migrations/001_schema.sql.
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION_SCHEMA = resolve(__dirname, '..', 'migrations', '001_schema.sql');

const MARK = `D${Date.now().toString(36).slice(-4).toUpperCase()}`;
const PERIODO = `T${Date.now().toString(36).slice(-4).toUpperCase()}`.slice(0, 6);
const HEADER_RA2 = [
  'COD_PRT', 'PPU', 'COD_VEHICULO', 'COD_COMBUSTIBLE', 'COD_SERVICIO',
  'MARCA', 'MODELO', 'ANO_FABRICACION', 'NUM_MOTOR', 'NUM_CHASIS', 'VIN',
  'KILOMETRAJE', 'NUM_CERTIFICADO', 'FEC_REVISION', 'FEC_VENCIMIENTO',
  'HORA_INI', 'HORA_FIN', 'RESULTADO_CRT', 'FEC_VENCIMIENTO_GASES',
  'RESULTADO_CRT_GASES', 'IDENTIFICACION', 'VISUAL', 'LUCES', 'ALINEACION',
  'FRENOS', 'HOLGURAS', 'SUSPENSION', 'GASES', 'OPACIDAD', 'ANGULO_GIRO',
  'V_CO_RALENTI', 'R_CO_RALENTI', 'V_HC_RALENTI', 'R_HC_RALENTI',
  'V_COCO2_RALENTI', 'R_COCO2_RALENTI', 'V_CO_2500RPM', 'R_CO_2500RPM',
  'V_HC_2500RPM', 'R_HC_2500RPM', 'V_COCO2_2500RPM', 'R_COCO2_2500RPM',
  'V_HC_STDR5015', 'R_HC_STDR5015', 'V_CO_STDR5015', 'R_CO_STDR5015',
  'V_NO_STDR5015', 'R_NO_STDR5015', 'V_HC_STDR2525', 'R_HC_STDR2525',
  'V_CO_STDR2525', 'R_CO_STDR2525', 'V_NO_STDR2525', 'R_NO_STDR2525',
  'R_HUMO', 'V_OPA1', 'V_OPA2', 'V_OPA3', 'V_OPA4', 'V_OPA5',
  'V_VALIDA_OPA', 'R_OPA_MEDIDA',
];
const idxRa2 = () => buildHeaderIndex([null, ...HEADER_RA2]);
const rowVals = (obj) => {
  const vals = [null];
  for (const h of HEADER_RA2) vals.push(obj[h] ?? null);
  return vals;
};

async function q(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

after(async () => {
  try {
    await q(`DELETE d FROM prt_revision_detalle d JOIN prt_revision r ON r.id = d.revision_id WHERE r.num_certificado LIKE ?`, [`${MARK}%`]);
    await q(`DELETE FROM prt_revision WHERE num_certificado LIKE ?`, [`${MARK}%`]);
  } finally {
    await pool.end();
  }
});

test('schema file creates prt_revision_detalle 1:1 with FK cascade', () => {
  assert.ok(existsSync(MIGRACION_SCHEMA), 'api-vehiculos/migrations/001_schema.sql must exist');
  const sql = readFileSync(MIGRACION_SCHEMA, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS `prt_revision_detalle`/i, 'must create prt_revision_detalle');
  assert.match(sql, /`revision_id` INT PRIMARY KEY/i, 'revision_id must be the PK (1:1)');
  assert.match(sql, /FOREIGN KEY[\s\S]*`revision_id`[\s\S]*REFERENCES `prt_revision`[\s\S]*ON DELETE CASCADE/i, 'revision_id must FK to prt_revision with cascade');
});

test('schema carries exactly the 46 RA2 measurement columns', () => {
  const sql = readFileSync(MIGRACION_SCHEMA, 'utf8');
  assert.equal(DETALLE_COLS.length, 46, 'DETALLE_COLS must list 46 columns per design');
  for (const c of DETALLE_COLS) {
    assert.match(sql, new RegExp(`\`${c}\``, 'i'), `migration must define column ${c}`);
  }
});

test('toTimeOrNull: Date, Excel fraction and strings', () => {
  assert.equal(toTimeOrNull(new Date('2026-01-02T08:15:30Z')), '08:15:30');
  assert.equal(toTimeOrNull(0.5), '12:00:00'); // Excel day fraction
  assert.equal(toTimeOrNull('9:05'), '09:05:00');
  assert.equal(toTimeOrNull('14:30:00'), '14:30:00');
  assert.equal(toTimeOrNull(null), null);
  assert.equal(toTimeOrNull(''), null);
  assert.equal(toTimeOrNull('basura'), null);
});

test('toDecimalOrNull: numbers pass, garbage is null', () => {
  assert.equal(toDecimalOrNull(0.45), 0.45);
  assert.equal(toDecimalOrNull('12.5'), 12.5);
  assert.equal(toDecimalOrNull(null), null);
  assert.equal(toDecimalOrNull(''), null);
  assert.equal(toDecimalOrNull('A'), null);
});

test('mapRowToDetalle: stations + gases + opacity (happy path)', () => {
  const d = mapRowToDetalle(
    rowVals({
      PPU: 'ab-1234', NUM_CERTIFICADO: `${MARK}1`,
      HORA_INI: '08:15:00', HORA_FIN: '08:45:00',
      FEC_VENCIMIENTO_GASES: '2027-01-02', RESULTADO_CRT_GASES: 'A',
      IDENTIFICACION: 'A', FRENOS: 'R', GASES: 'A', OPACIDAD: 'A',
      V_CO_RALENTI: 0.45, R_CO_RALENTI: 'A', V_HC_RALENTI: 120, R_HC_RALENTI: 'A',
      V_OPA1: 0.12, V_OPA2: 0.1, V_VALIDA_OPA: 'S', R_OPA_MEDIDA: 'A',
    }),
    idxRa2(),
  );
  assert.equal(d.ppu, 'AB1234');
  assert.equal(d.num_certificado, `${MARK}1`);
  assert.equal(d.hora_ini, '08:15:00');
  assert.equal(d.fec_vencimiento_gases, '2027-01-02');
  assert.equal(d.identificacion, 'A');
  assert.equal(d.frenos, 'R');
  assert.equal(d.v_co_ralenti, 0.45);
  assert.equal(d.r_co_ralenti, 'A');
  assert.equal(d.v_hc_ralenti, 120);
  assert.equal(d.v_opa1, 0.12);
  assert.equal(d.v_valida_opa, 'S');
  assert.equal(d.r_opa_medida, 'A');
  assert.equal(d.suspension, null); // absent → null, never invented
});

test('mapRowToDetalle: STDR5015/2525 triangulate + missing headers stay null', () => {
  const d = mapRowToDetalle(
    rowVals({
      PPU: 'ZZ9999', NUM_CERTIFICADO: `${MARK}2`,
      V_HC_STDR5015: 80, R_HC_STDR5015: 'R', V_NO_STDR5015: 900,
      V_CO_STDR2525: 0.3, R_NO_STDR2525: 'A', R_HUMO: 'L',
      HORA_INI: 0.34375, // 08:15 as Excel fraction
    }),
    idxRa2(),
  );
  assert.equal(d.v_hc_stdr5015, 80);
  assert.equal(d.r_hc_stdr5015, 'R');
  assert.equal(d.v_no_stdr5015, 900);
  assert.equal(d.v_co_stdr2525, 0.3);
  assert.equal(d.r_no_stdr2525, 'A');
  assert.equal(d.r_humo, 'L');
  assert.equal(d.hora_ini, '08:15:00');
  assert.equal(d.v_co_ralenti, null);
  assert.equal(d.angulo_giro, null);
});

test('upsertBatchDetalle: idempotent, re-run converges values without dupes', async () => {
  const conn = await pool.getConnection();
  try {
    const parents = [1, 2].map((i) => mapRowToRecord(
      rowVals({ PPU: `${MARK}P${i}`, NUM_CERTIFICADO: `${MARK}C${i}`, MARCA: 'Toyota', KILOMETRAJE: 50000 }),
      idxRa2(),
      PERIODO,
    ));
    await upsertBatch(conn, parents);
    const det = (co, humo) => ({
      ...mapRowToDetalle(rowVals({ PPU: `${MARK}P1`, NUM_CERTIFICADO: `${MARK}C1`, V_CO_RALENTI: co, R_HUMO: humo }), idxRa2()),
    });
    await upsertBatchDetalle(conn, [det(0.45, 'L')]);
    const c1 = await checksumDetalle(conn, PERIODO);
    await upsertBatchDetalle(conn, [det(0.45, 'L')]);
    const c2 = await checksumDetalle(conn, PERIODO);
    assert.equal(c2.n, c1.n, 're-run must not duplicate detalle rows');
    assert.equal(c2.chk, c1.chk, 're-run with same values must converge checksum');
    await upsertBatchDetalle(conn, [det(0.9, 'L')]);
    const c3 = await checksumDetalle(conn, PERIODO);
    assert.equal(c3.n, c2.n, 'value change must update, not insert');
    assert.notEqual(c3.chk, c2.chk, 'value change must move the checksum');
    const rows = await q(
      `SELECT d.v_co_ralenti AS co FROM prt_revision_detalle d JOIN prt_revision r ON r.id = d.revision_id WHERE r.num_certificado = ?`,
      [`${MARK}C1`],
    );
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].co), 0.9);
  } finally {
    conn.release();
  }
});

test('upsertBatchDetalle: skips orphans without parents', async () => {
  const conn = await pool.getConnection();
  try {
    const res = await upsertBatchDetalle(conn, [{
      ...mapRowToDetalle(rowVals({ PPU: `ZZZORFAN`, NUM_CERTIFICADO: `${MARK}ORFAN` }), idxRa2()),
    }]);
    assert.equal(res.skipped, 1, 'detalle without prt_revision parent must be skipped');
    assert.equal(res.upserted, 0);
  } finally {
    conn.release();
  }
});
