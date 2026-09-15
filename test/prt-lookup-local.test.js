import './helpers/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/index.js';
import { buscarPrtLocal, mapPrtRowToContract } from '../src/services/prt.service.js';
import { resolverPatente, lookupLocal, RESOLVER_FIELDS } from '../src/services/resolucion.service.js';
import { lookupLocalHandler } from '../src/controllers/vehiculo.controller.js';
import { vehiculoRouter } from '../src/routes/vehiculo.routes.js';

// REQ: PRT Local Lookup — capa resolver síncrona + endpoint.
// Orden estricto: caché propia → PRT local → fallback manual. No hay worker
// ni scraper: el resolver nunca navega y nunca escribe. Placas QQ10xx
// reservadas para este archivo (sin colisiones con otros suites).

const MARK = `plocal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
async function q(sql, params = {}) {
  const [r] = await pool.execute(sql, params);
  return r;
}

before(async () => {
  // PRT-hit: ultima por FEC_REVISION es CERT-NEW.
  await q(`INSERT INTO prt_revision (ppu, num_certificado, periodo, marca, modelo, anio_fabricacion, numero_motor, numero_chasis, vin, kilometraje, fec_revision, fec_vencimiento, resultado_crt, planta, cod_combustible, cod_servicio) VALUES ('QQ1001', 'CERT-OLD', '202601', 'NISSAN', 'NOTE', 2013, 'M1', 'C1', '0', 40000, '2025-12-05', '2026-12-05', 'A', 'AB0105', '1', '3')`);
  await q(`INSERT INTO prt_revision (ppu, num_certificado, periodo, marca, modelo, anio_fabricacion, numero_motor, numero_chasis, vin, kilometraje, fec_revision, fec_vencimiento, resultado_crt, planta, cod_combustible, cod_servicio) VALUES ('QQ1001', 'CERT-NEW', '202601', 'NISSAN', 'NOTE', 2013, 'M1', 'C1', 'VIN123REAL', 66582, '2026-01-02', '2027-01-02', 'A', 'AB0105', '1', '3')`);
  await q(`INSERT INTO prt_revision (ppu, num_certificado, periodo, marca, kilometraje, fec_revision) VALUES ('QQ1006', 'CERT-1', '202601', 'EndpointMarca', 66582, '2026-01-02')`);
  // Caché fresca de una PPU sin revisión PRT → origen 'cache'.
  await q(`INSERT INTO vehiculo_consulta (ppu, patente, marca, origen, consultado_at) VALUES ('QQ1002', 'QQ1002', 'CacheMarca', 'prt-local', NOW())`);
});

after(async () => {
  await q(`DELETE FROM prt_revision WHERE ppu LIKE 'QQ100%'`);
  await q(`DELETE FROM vehiculo_consulta WHERE ppu LIKE 'QQ100%'`);
  await pool.end();
});

test('mapper: contrato 10 campos, gaps → null, nada inventado', () => {
  const row = {
    ppu: 'QQ1001', marca: 'NISSAN', modelo: 'NOTE', anioFabricacion: 2013,
    numeroMotor: 'M1', numeroChasis: null, vin: 'VIN123REAL', kilometraje: 66582,
    codCombustible: '1', codServicio: '3', // sin diccionario fijado → null
  };
  const c = mapPrtRowToContract(row);
  assert.equal(c.marca, 'NISSAN');
  assert.equal(c.numeroChasis, 'VIN123REAL'); // fallback a VIN
  assert.equal(c.color, null);
  assert.ok(!('procedencia' in c), 'procedencia fuera del contrato');
  assert.ok(!('fabricante' in c), 'fabricante fuera del contrato');
  assert.ok(!('sello' in c), 'sello fuera del contrato');
  assert.equal(c.tipo, null);
  assert.equal(c.combustible, null);
  assert.equal(c.kilometraje, 66582);
  assert.equal(Object.keys(c).length, 10);
});

test('buscarPrtLocal: ultima por FEC_REVISION desc', async () => {
  const row = await buscarPrtLocal('QQ1001');
  assert.equal(row.numCertificado, 'CERT-NEW');
  assert.equal(row.kilometraje, 66582);
  assert.equal(await buscarPrtLocal('QQ9999'), null);
});

test('resolver: PRT-hit devuelve contrato enriquecido origen prt-local', async () => {
  const r = await resolverPatente('QQ1001');
  assert.equal(r.origen, 'prt-local');
  assert.equal(r.marca, 'NISSAN');
  assert.equal(r.manualEntry, false);
  assert.equal(r.numCertificado, 'CERT-NEW');
  assert.equal(r.patenteNormalizada, 'QQ1001');
});

test('resolver: cache fresca gana y devuelve origen cache', async () => {
  const r = await resolverPatente('QQ1002');
  assert.equal(r.origen, 'cache');
  assert.equal(r.marca, 'CacheMarca');
  assert.equal(r.manualEntry, false);
});

test('resolver: force salta la cache y sin PRT cae a manual', async () => {
  const r = await resolverPatente('QQ1002', { force: true });
  assert.equal(r.origen, 'manual');
  assert.equal(r.manualEntry, true);
  assert.equal(r.marca, null);
});

test('resolver: PRT-miss sin cache → fallback manual con fields', async () => {
  const r = await resolverPatente('QQ1099');
  assert.equal(r.origen, 'manual');
  assert.equal(r.manualEntry, true);
  assert.equal(r.patenteNormalizada, 'QQ1099');
  assert.deepEqual([...r.fields].sort(), [...RESOLVER_FIELDS].sort());
});

test('endpoint service: lookupLocal 200 mapeado y 404 si no existe', async () => {
  const ok = await lookupLocal('qq-1006');
  assert.equal(ok.marca, 'EndpointMarca');
  assert.equal(ok.origen, 'prt-local');
  assert.equal(ok.patenteNormalizada, 'QQ1006');
  await assert.rejects(lookupLocal('QQ9999'), (e) => e.httpStatus === 404);
  await assert.rejects(lookupLocal('   '), (e) => e.httpStatus === 422);
});

test('endpoint handler: 200 json via lookupLocalHandler', async () => {
  let status = 0;
  let body = null;
  await lookupLocalHandler({ params: { ppu: 'QQ1006' } }, { status: (s) => { status = s; return { json: (b) => { body = b; } }; } }, (e) => { throw e; });
  assert.equal(status, 200);
  assert.equal(body.marca, 'EndpointMarca');
});

test('ruta: /lookup-local/:ppu registrada BEFORE /:ppu', () => {
  const paths = vehiculoRouter.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
  const local = paths.indexOf('GET /lookup-local/:ppu');
  const byId = paths.indexOf('GET /:ppu');
  assert.ok(local !== -1, `lookup-local registrada: ${paths.join(', ')}`);
  assert.ok(byId !== -1);
  assert.ok(local < byId, 'lookup-local debe ir antes de /:ppu');
});

test('contrato PRT trae los 10 campos + sin badge', async () => {
  const r = await lookupLocal('QQ1001');
  for (const f of RESOLVER_FIELDS) {
    const camel = f === 'numero_motor' ? 'numeroMotor' : f === 'numero_chasis' ? 'numeroChasis' : f;
    assert.ok(camel in r, `falta campo ${camel}`);
  }
  assert.ok(!('badge' in r) && !('fuente_badge' in r));
});
