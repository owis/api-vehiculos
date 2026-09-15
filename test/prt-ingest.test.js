import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { pool } from '../src/db/index.js';
import {
  normalizarPpu,
  toIntOrNull,
  toDateOnly,
  buildHeaderIndex,
  mapRowToRecord,
  ingestWorkbook,
  upsertBatch,
  checksumPeriodo,
} from '../scripts/ingest-prt.js';

// REQ: PRT Local Lookup — ingesta piloto (tasks 2.1, 2.2).
//
// Helpers puros + streaming por batches contra un xlsx fixture generado
// en el test (sin depender del xlsx real de 159 MB) + idempotencia del
// upsert contra la BD del servicio (api_vehiculos) (re-correr cambia cero filas).

const HEADER_RB = [
  'COD_PRT', 'PPU', 'COD_VEHICULO', 'COD_COMBUSTIBLE', 'COD_SERVICIO',
  'MARCA', 'MODELO', 'ANO_FABRICACION', 'NUM_MOTOR', 'NUM_CHASIS', 'VIN',
  'KILOMETRAJE', 'NUM_CERTIFICADO', 'FEC_REVISION', 'FEC_VENCIMIENTO',
  'HORA_INI', 'HORA_FIN', 'RESULTADO_CRT',
];
const idxRb = () => buildHeaderIndex([null, ...HEADER_RB]);

const MARK = `ING${Date.now().toString(36).slice(-4).toUpperCase()}`;
const rowVals = (obj) => {
  const vals = [null];
  for (const h of HEADER_RB) vals.push(obj[h] ?? null);
  return vals;
};

async function q(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

after(async () => {
  try {
    await q(`DELETE FROM prt_revision WHERE num_certificado LIKE ?`, [`${MARK}%`]);
  } finally {
    await pool.end();
  }
});

test('normalizarPpu: mayusculas y solo alfanumerico', () => {
  assert.equal(normalizarPpu('vlt-j50'), 'VLTJ50');
  assert.equal(normalizarPpu('  AB 1234 '), 'AB1234');
});

test('toIntOrNull: trunca y rechaza basura', () => {
  assert.equal(toIntOrNull(66582), 66582);
  assert.equal(toIntOrNull('918177'), 918177);
  assert.equal(toIntOrNull(null), null);
  assert.equal(toIntOrNull(''), null);
  assert.equal(toIntOrNull('abc'), null);
});

test('toDateOnly: Date, serial Excel y strings', () => {
  assert.equal(toDateOnly(new Date('2026-01-02T00:00:00Z')), '2026-01-02');
  assert.equal(toDateOnly(46024), '2026-01-02'); // serial Excel
  assert.equal(toDateOnly('2026-01-03 00:00:00'), '2026-01-03');
  assert.equal(toDateOnly(null), null);
  assert.equal(toDateOnly('basura'), null);
});

test('mapRowToRecord: nucleo RB + sentinels (VIN 0, NULL literal)', () => {
  const rec = mapRowToRecord(
    rowVals({
      COD_PRT: 'AB0105', PPU: 'vlt-j50', MARCA: 'NISSAN', MODELO: 'NOTE',
      ANO_FABRICACION: 2013, NUM_MOTOR: 'HR12-168155A', NUM_CHASIS: 'E12-107726',
      VIN: '0', KILOMETRAJE: 66582, NUM_CERTIFICADO: `${MARK}1`,
      FEC_REVISION: new Date('2026-01-02T00:00:00Z'), FEC_VENCIMIENTO: '2026-01-03',
      RESULTADO_CRT: 'R', COD_COMBUSTIBLE: 1, COD_SERVICIO: 3,
    }),
    idxRb(),
    '202601',
  );
  assert.equal(rec.ppu, 'VLTJ50');
  assert.equal(rec.marca, 'NISSAN');
  assert.equal(rec.vin, null); // '0' = ausente
  assert.equal(rec.kilometraje, 66582);
  assert.equal(rec.fec_revision, '2026-01-02');
  assert.equal(rec.resultado_crt, 'R');
  assert.equal(rec.planta, 'AB0105');
  assert.equal(rec.periodo, '202601');
});

test('mapRowToRecord: sin PPU o sin certificado se descarta', () => {
  assert.equal(mapRowToRecord(rowVals({ PPU: '', NUM_CERTIFICADO: `${MARK}X` }), idxRb(), '202601'), null);
  assert.equal(mapRowToRecord(rowVals({ PPU: 'AB1234', NUM_CERTIFICADO: '' }), idxRb(), '202601'), null);
});

test('ingestWorkbook: streaming por batches desde fixture (sin xlsx real)', async () => {
  const xlsxPath = join(tmpdir(), `prt-fixture-${Date.now()}.xlsx`);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Hoja1');
  ws.addRow(HEADER_RB);
  for (let i = 1; i <= 5; i++) {
    ws.addRow(['AB0105', `QA000${i}`, 4, 1, 3, 'NISSAN', 'NOTE', 2013, 'M1', 'C1', '0', 60000 + i, `${MARK}F${i}`, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-03T00:00:00Z'), null, null, 'A']);
  }
  await wb.xlsx.writeFile(xlsxPath);

  const seen = [];
  const { filas, batches } = await ingestWorkbook(xlsxPath, {
    periodo: '202601',
    batchSize: 2,
    sink: async (chunk) => { seen.push(...chunk); },
  });
  assert.equal(filas, 5);
  assert.equal(batches, 3); // 2+2+1: streaming real, nunca full-load en un solo batch
  assert.equal(seen.length, 5);
  assert.equal(seen[0].ppu, 'QA0001');
  assert.equal(seen[4].kilometraje, 60005);
});

test('upsertBatch: idempotente, re-correr cambia cero filas', async () => {
  const recs = [
    { ppu: `${MARK}P1`, num_certificado: `${MARK}C1`, periodo: '202601', marca: 'Toyota', modelo: 'Yaris', anio_fabricacion: 2019, numero_motor: 'M1', numero_chasis: 'C1', vin: null, kilometraje: 50000, fec_revision: '2026-01-10', fec_vencimiento: '2027-01-10', resultado_crt: 'A', planta: 'AB0105', cod_combustible: '1', cod_servicio: '3' },
    { ppu: `${MARK}P1`, num_certificado: `${MARK}C2`, periodo: '202601', marca: 'Toyota', modelo: 'Yaris', anio_fabricacion: 2019, numero_motor: 'M1', numero_chasis: 'C1', vin: null, kilometraje: 51000, fec_revision: '2026-01-15', fec_vencimiento: '2027-01-15', resultado_crt: 'A', planta: 'AB0105', cod_combustible: '1', cod_servicio: '3' },
  ];
  const conn = await pool.getConnection();
  try {
    await upsertBatch(conn, recs);
    const c1 = await checksumPeriodo(conn, '202601');
    await upsertBatch(conn, recs);
    const c2 = await checksumPeriodo(conn, '202601');
    // Idempotencia real: mismo COUNT y mismo contenido (affectedRows del
    // cliente no sirve: mysql2 reporta found-rows, no changed-rows).
    assert.equal(c2.n, c1.n);
    assert.equal(c2.chk, c1.chk);
    const rows = await q(`SELECT COUNT(*) AS n FROM prt_revision WHERE num_certificado LIKE ?`, [`${MARK}%`]);
    assert.equal(rows[0].n, 2);
  } finally {
    conn.release();
  }
});
