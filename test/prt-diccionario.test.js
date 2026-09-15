import './helpers/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/index.js';
import { buscarPrtLocal, mapPrtRowToContract } from '../src/services/prt.service.js';
import { lookupLocal } from '../src/services/resolucion.service.js';

// REQ: PRT diccionarios — codigos a nombres en el lookup.
// Tabla `prt_diccionario` cargada por api-vehiculos/scripts/seed-prt-diccionarios.js
// desde Codigos_SGPRT.xlsx + Codigos_Plantas.xlsx. Placas QQ90xx reservadas
// para este archivo (sin colisiones con otros suites).
//
// Servicio autónomo (BD `api_vehiculos`): sin usuario/empresa, solo PRT global.

const MARK = `plocal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
async function q(sql, params = []) {
  const [r] = await pool.execute(sql, params);
  return r;
}
async function q1(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows[0] ?? null;
}

before(async () => {
  // Fila con codigos conocidos: 2→DIESEL, 4→STATION WAGON, 3→servicio, AB1026→planta.
  await q(`INSERT INTO prt_revision (ppu, num_certificado, periodo, marca, modelo, anio_fabricacion, kilometraje, fec_revision, planta, cod_combustible, cod_servicio, cod_vehiculo) VALUES ('QQ9001', '${MARK}C1', '202601', 'NISSAN', 'NOTE', 2013, 66582, '2026-01-02', 'AB1026', '2', '3', '4')`);
  // Fila con codigos desconocidos → null (nada inventado).
  await q(`INSERT INTO prt_revision (ppu, num_certificado, periodo, marca, kilometraje, fec_revision, planta, cod_combustible, cod_servicio, cod_vehiculo) VALUES ('QQ9002', '${MARK}C2', '202601', 'XMarca', 10000, '2026-01-02', 'ZZ9999', '99', '88', '77')`);
});

after(async () => {
  await q(`DELETE FROM prt_revision WHERE ppu LIKE 'QQ900%'`);
  await pool.end();
});

test('diccionario: categorias y cantidades del seed oficial', async () => {
  const rows = await q(`SELECT categoria, COUNT(*) AS n FROM prt_diccionario GROUP BY categoria`);
  const porCat = Object.fromEntries(rows.map((r) => [r.categoria, Number(r.n)]));
  assert.equal(porCat.combustible, 11); // TIPO DE COMBUSTIBLE 0-10
  assert.equal(porCat.servicio, 22); // TIPO DE SERVICIO 0-20 + 999
  assert.equal(porCat.vehiculo, 75); // TIPO DE VEHÍCULO
  assert.equal(porCat.planta, 267); // Hoja1 (269 filas - 2 duplicadas identicas)
});

test('diccionario: valores spot del xlsx oficial', async () => {
  const nombre = async (cat, cod) => (await q1(
    `SELECT nombre FROM prt_diccionario WHERE categoria = ? AND codigo = ?`, [cat, cod],
  ))?.nombre ?? null;
  assert.equal(await nombre('combustible', '2'), 'DIESEL');
  assert.equal(await nombre('vehiculo', '4'), 'STATION WAGON');
  assert.equal(await nombre('servicio', '999'), 'OTRO');
  assert.equal(
    await nombre('planta', 'AB1026'),
    'REVISIONES LOS LAGOS LIMITADA (OSORNO, REGIÓN 10)',
  );
});

test('lookup: codigos resuelven a nombres (2→DIESEL, 4→STATION WAGON, AB1026)', async () => {
  const row = await buscarPrtLocal('QQ9001');
  assert.equal(row.combustible, 'DIESEL');
  assert.equal(row.tipoVehiculo, 'STATION WAGON');
  assert.equal(row.servicio, 'PRIVADO-PARTICULAR [A1] [A2] [B]');
  assert.equal(row.plantaNombre, 'REVISIONES LOS LAGOS LIMITADA (OSORNO, REGIÓN 10)');
  const c = mapPrtRowToContract(row);
  assert.equal(c.combustible, 'DIESEL');
  assert.equal(c.tipo, 'STATION WAGON');
  const full = await lookupLocal('QQ9001');
  assert.equal(full.combustible, 'DIESEL');
  assert.equal(full.tipo, 'STATION WAGON');
  assert.equal(full.servicio, 'PRIVADO-PARTICULAR [A1] [A2] [B]');
  assert.equal(full.plantaNombre, 'REVISIONES LOS LAGOS LIMITADA (OSORNO, REGIÓN 10)');
});

test('lookup: codigo ausente o sin diccionario → null', async () => {
  const row = await buscarPrtLocal('QQ9002');
  assert.equal(row.combustible, null);
  assert.equal(row.tipoVehiculo, null);
  assert.equal(row.servicio, null);
  assert.equal(row.plantaNombre, null);
  const c = mapPrtRowToContract(row);
  assert.equal(c.combustible, null);
  assert.equal(c.tipo, null);
});

test('mapper puro: fila pre-resuelta mapea nombres, fila cruda sin dict → null', () => {
  const resuelta = {
    ppu: 'QQ9001', marca: 'NISSAN', modelo: 'NOTE', anioFabricacion: 2013,
    numeroMotor: 'M1', numeroChasis: null, vin: 'VIN1', kilometraje: 66582,
    codCombustible: '2', codServicio: '3', codVehiculo: '4',
    combustible: 'DIESEL', tipoVehiculo: 'STATION WAGON',
    servicio: 'PRIVADO-PARTICULAR [A1] [A2] [B]', plantaNombre: 'P (C, REGIÓN 1)',
  };
  const c = mapPrtRowToContract(resuelta);
  assert.equal(c.combustible, 'DIESEL');
  assert.equal(c.tipo, 'STATION WAGON');
  const cruda = { ...resuelta, combustible: null, tipoVehiculo: null };
  const c2 = mapPrtRowToContract(cruda);
  assert.equal(c2.combustible, null); // JSON fijado vacio → null
  assert.equal(c2.tipo, null);
});
