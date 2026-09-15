import { query, queryOne } from '../db/index.js';
import { env } from '../config/index.js';
import { HttpError } from '../middleware/errors.js';
import {
  normalizarPatente,
  validarPatente,
  buscarPrtLocal,
  mapPrtRowToContract,
} from './prt.service.js';

// Resolver de patentes SOLO LECTURA.
//
// Orden estricto: caché propia → PRT local → fallback manual.
// No hay capa worker ni scraper de patentechile.com: este servicio no navega.
// No muta nada durante un lookup; la caché se escribe únicamente con
// `guardarConsulta()` (llamada explícita desde el endpoint de guardado).

export const RESOLVER_FIELDS = [
  'patente', 'tipo', 'marca', 'modelo', 'anio', 'color',
  'numero_motor', 'numero_chasis', 'combustible', 'kilometraje',
];

export async function buscarCache(ppu) {
  const normalizada = normalizarPatente(ppu);
  if (!normalizada) return null;
  return queryOne(
    `SELECT id, ppu, patente, tipo, marca, modelo, anio, color,
            numero_motor AS numeroMotor, numero_chasis AS numeroChasis,
            combustible, kilometraje, origen, resultado_crt AS resultadoCrt,
            fec_revision AS fecRevision, fec_vencimiento AS fecVencimiento,
            num_certificado AS numCertificado, consultado_at AS consultadoAt
       FROM vehiculo_consulta
      WHERE ppu = :normalizada
        AND consultado_at >= NOW() - INTERVAL ${env.cacheTtlDays} DAY`,
    { normalizada },
  );
}

function rowToResolved(row) {
  return {
    patente: row.patente,
    tipo: row.tipo,
    marca: row.marca,
    modelo: row.modelo,
    anio: row.anio,
    color: row.color,
    numeroMotor: row.numeroMotor,
    numeroChasis: row.numeroChasis,
    combustible: row.combustible,
    kilometraje: row.kilometraje,
    patenteNormalizada: row.ppu,
    patente_normalizada: row.ppu,
    origen: 'cache',
    manualEntry: false,
    manual_entry: false,
    numCertificado: row.numCertificado ?? null,
    resultadoCrt: row.resultadoCrt ?? null,
    fecRevision: row.fecRevision ?? null,
    fecVencimiento: row.fecVencimiento ?? null,
  };
}

function manualFallback(normalizada) {
  return {
    patente: normalizada,
    patenteNormalizada: normalizada,
    patente_normalizada: normalizada,
    tipo: null, marca: null, modelo: null, anio: null, color: null,
    numeroMotor: null, numeroChasis: null, combustible: null, kilometraje: null,
    origen: 'manual',
    manualEntry: true,
    manual_entry: true,
    fields: [...RESOLVER_FIELDS],
  };
}

function prtEnriquecido(row, contract, normalizada) {
  return {
    ...contract,
    patenteNormalizada: normalizada,
    patente_normalizada: normalizada,
    manualEntry: false,
    manual_entry: false,
    origen: 'prt-local',
    fecRevision: row.fecRevision ?? null,
    fecVencimiento: row.fecVencimiento ?? null,
    resultadoCrt: row.resultadoCrt ?? null,
    numCertificado: row.numCertificado ?? null,
    servicio: row.servicio ?? null,
    plantaNombre: row.plantaNombre ?? null,
  };
}

// Resolución pura: nunca escribe. `force` salta la caché fresca y re-consulta PRT.
export async function resolverPatente(patente, { force = false } = {}) {
  const err = validarPatente(patente);
  if (err) throw err;
  const normalizada = normalizarPatente(patente);

  if (!force) {
    const cached = await buscarCache(normalizada);
    if (cached) return rowToResolved(cached);
  }

  const prt = await buscarPrtLocal(normalizada);
  if (prt) {
    return prtEnriquecido(prt, mapPrtRowToContract(prt), normalizada);
  }

  return manualFallback(normalizada);
}

// Última revisión PRT mapeada al contrato (endpoint lookup-local). 404 si la
// PPU no existe en prt_revision. Solo lectura.
export async function lookupLocal(ppu) {
  const err = validarPatente(ppu);
  if (err) throw err;
  const normalizada = normalizarPatente(ppu);
  const row = await buscarPrtLocal(normalizada);
  if (!row) throw new HttpError(404, 'prt_revision_no_encontrada');
  return prtEnriquecido(row, mapPrtRowToContract(row), normalizada);
}

// Persistencia explícita de la caché por PPU (upsert por UNIQUE(ppu)).
// La invoca el consumidor (bit) SOLO al guardar/refrescar el vehículo.
// Nunca se llama desde `resolverPatente`.
export async function guardarConsulta(data) {
  const normalizada = normalizarPatente(data?.patente ?? data?.patenteNormalizada);
  if (!normalizada) throw new HttpError(422, 'patente_requerida');
  const origen = data?.origen || 'manual';
  const patente = String(data?.patente || normalizada).toUpperCase().trim();

  await query(
    `INSERT INTO vehiculo_consulta
       (ppu, patente, tipo, marca, modelo, anio, color, numero_motor, numero_chasis,
        combustible, kilometraje, origen, resultado_crt, fec_revision, fec_vencimiento,
        num_certificado, consultado_at)
     VALUES
       (:ppu, :patente, :tipo, :marca, :modelo, :anio, :color, :numeroMotor, :numeroChasis,
        :combustible, :kilometraje, :origen, :resultadoCrt, :fecRevision, :fecVencimiento,
        :numCertificado, NOW())
     ON DUPLICATE KEY UPDATE
       patente = VALUES(patente), tipo = VALUES(tipo), marca = VALUES(marca),
       modelo = VALUES(modelo), anio = VALUES(anio), color = VALUES(color),
       numero_motor = VALUES(numero_motor), numero_chasis = VALUES(numero_chasis),
       combustible = VALUES(combustible), kilometraje = VALUES(kilometraje),
       origen = VALUES(origen), resultado_crt = VALUES(resultado_crt),
       fec_revision = VALUES(fec_revision), fec_vencimiento = VALUES(fec_vencimiento),
       num_certificado = VALUES(num_certificado), consultado_at = NOW()`,
    {
      ppu: normalizada,
      patente,
      tipo: data?.tipo ?? null,
      marca: data?.marca ?? null,
      modelo: data?.modelo ?? null,
      anio: data?.anio ?? null,
      color: data?.color ?? null,
      numeroMotor: data?.numeroMotor ?? data?.numero_motor ?? null,
      numeroChasis: data?.numeroChasis ?? data?.numero_chasis ?? null,
      combustible: data?.combustible ?? null,
      kilometraje: data?.kilometraje ?? null,
      origen,
      resultadoCrt: data?.resultadoCrt ?? null,
      fecRevision: data?.fecRevision ?? null,
      fecVencimiento: data?.fecVencimiento ?? null,
      numCertificado: data?.numCertificado ?? null,
    },
  );

  return { ok: true, ppu: normalizada, origen };
}
