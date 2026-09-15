import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/index.js';
import { getRevisiones } from '../src/services/prt.service.js';

// REQ: prt-measurements — historial de revisiones + detalle 1:1.
// Servicio autónomo (BD `api_vehiculos`): el historial se lee directo de
// `prt_revision`/`prt_revision_detalle`; no hay scoping por empresa/vehículo
// en el servicio (ese mapeo vehículo→PPU vive en bit).

const MARK = 'PR2RT';

const q = async (sql, params = []) => {
  const [rows] = await pool.execute(sql, params);
  return rows;
};

before(async () => {
  await q(`DELETE FROM prt_revision_detalle WHERE revision_id IN (SELECT id FROM prt_revision WHERE ppu LIKE '${MARK}%')`).catch(() => {});
  await q(`DELETE FROM prt_revision WHERE ppu LIKE '${MARK}%'`).catch(() => {});
});

after(async () => {
  try {
    await q(`DELETE FROM prt_revision_detalle WHERE revision_id IN (SELECT id FROM (SELECT id FROM prt_revision WHERE ppu LIKE '${MARK}%') x)`).catch(() => {});
    await q(`DELETE FROM prt_revision WHERE ppu LIKE '${MARK}%'`);
  } finally {
    await pool.end();
  }
});

async function seedRevision(ppu, cert, fec, km, extra = {}) {
  const r = await q(
    `INSERT INTO prt_revision (ppu, num_certificado, periodo, marca, modelo, anio_fabricacion, kilometraje, fec_revision, resultado_crt)
     VALUES (?, ?, '202606', 'M', 'X', 2020, ?, ?, 'A')`,
    [ppu, cert, km, fec],
  );
  const d = await q(`INSERT INTO prt_revision_detalle (revision_id, identificacion, visual, frenos, v_co_ralenti, r_humo) VALUES (?, 'A', 'A', 'A', ?, ?)`, [
    r.insertId,
    extra.vCo ?? '0.15',
    extra.rHumo ?? '1',
  ]);
  return { revisionId: Number(r.insertId), detalleId: Number(d.insertId) };
}

test('getRevisiones: historial ordenado por fec_revision desc con mediciones', async () => {
  const ppu = `${MARK}AA`;
  await seedRevision(ppu, 'CERT-OLD', '2025-06-01', 100000);
  await seedRevision(ppu, 'CERT-NEW', '2026-06-01', 150000, { vCo: '0.22' });
  const rs = await getRevisiones(ppu);
  assert.equal(rs.length, 2);
  assert.equal(rs[0].numCertificado, 'CERT-NEW');
  assert.equal(rs[0].estaciones.frenos, 'A');
  assert.equal(rs[0].gases.vCoRalenti, 0.22);
  assert.equal(rs[0].opacidad.rHumo, '1');
  // más antigua al final
  assert.equal(rs[1].numCertificado, 'CERT-OLD');
});

test('getRevisiones: sin detalle → estaciones/gases en null, no inventa', async () => {
  const ppu = `${MARK}BB`;
  await q(
    `INSERT INTO prt_revision (ppu, num_certificado, periodo, kilometraje, fec_revision) VALUES (?, 'CERT-BARE', '202601', 90000, '2026-01-15')`,
    [ppu],
  );
  const rs = await getRevisiones(ppu);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].estaciones.frenos, null);
  assert.equal(rs[0].gases.vCoRalenti, null);
  assert.equal(rs[0].numCertificado, 'CERT-BARE');
});

test('getRevisiones: mediciones por certificado y PPU desconocida → []', async () => {
  const ppu = `${MARK}CC`;
  await seedRevision(ppu, 'CERT-CC', '2026-03-01', 123456, { vCo: '0.30', rHumo: 'L' });
  const rs = await getRevisiones(ppu);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].numCertificado, 'CERT-CC');
  assert.equal(rs[0].gases.vCoRalenti, 0.3);
  assert.equal(rs[0].opacidad.rHumo, 'L');
  assert.deepEqual(await getRevisiones(`${MARK}ZZ`), []);
});

test('getRevisiones: patente vacía 422', async () => {
  await assert.rejects(getRevisiones('   '), (e) => e.httpStatus === 422);
});
