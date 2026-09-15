import { query, queryOne } from '../db/index.js';
import { HttpError } from '../middleware/errors.js';

// Acceso de lectura a la data PRT local (open data prt.cl). Sin mutaciones:
// este servicio resuelve y devuelve; la persistencia de negocio vive en bit.

const PPU_RE = /^(?:[A-Z]{2}\d{4}|[A-Z]{3}\d{3}|[A-Z]{4}\d{2})$/;

export function normalizarPatente(patente) {
  return String(patente || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function validarPatente(patente) {
  const normalizada = normalizarPatente(patente);
  if (!normalizada) return new HttpError(422, 'patente_requerida');
  if (!PPU_RE.test(normalizada)) {
    return new HttpError(422, 'patente_formato_invalido: se espera XX1234, XXX123 o BBBB12');
  }
  return null;
}

// Última revisión PRT por PPU (ORDER BY fec_revision DESC). JOIN a
// prt_diccionario para resolver nombres oficiales de combustible/tipo/planta.
export async function buscarPrtLocal(ppu) {
  const normalizada = normalizarPatente(ppu);
  if (!normalizada) return null;
  return queryOne(
    `SELECT ppu, num_certificado AS numCertificado, periodo,
            marca, modelo, anio_fabricacion AS anioFabricacion,
            numero_motor AS numeroMotor, numero_chasis AS numeroChasis,
            vin, kilometraje,
            fec_revision AS fecRevision, fec_vencimiento AS fecVencimiento,
            resultado_crt AS resultadoCrt, planta,
            cod_combustible AS codCombustible, cod_servicio AS codServicio,
            cod_vehiculo AS codVehiculo,
            d_comb.nombre AS combustible, d_serv.nombre AS servicio,
            d_veh.nombre AS tipoVehiculo, d_planta.nombre AS plantaNombre
       FROM prt_revision r
       LEFT JOIN prt_diccionario d_comb
         ON d_comb.categoria = 'combustible' AND d_comb.codigo = r.cod_combustible
       LEFT JOIN prt_diccionario d_serv
         ON d_serv.categoria = 'servicio' AND d_serv.codigo = r.cod_servicio
       LEFT JOIN prt_diccionario d_veh
         ON d_veh.categoria = 'vehiculo' AND d_veh.codigo = r.cod_vehiculo
       LEFT JOIN prt_diccionario d_planta
         ON d_planta.categoria = 'planta' AND d_planta.codigo = r.planta
      WHERE ppu = :normalizada
      ORDER BY fec_revision DESC
      LIMIT 1`,
    { normalizada },
  );
}

// Mapeo PRT → contrato de 10 campos. color siempre null (manual-only en bit);
// chasis cae a VIN; ausentes quedan null (nada inventado).
// Mapeo PRT → contrato de 10 campos. `tipo` sale SOLO del nombre resuelto por
// el diccionario (`tipoVehiculo`, JOIN en buscarPrtLocal); un `codVehiculo` sin
// entrada de diccionario mapea a null (nada inventado). `color` siempre null
// (manual-only en bit); chasis cae a VIN; ausentes quedan null.
export function mapPrtRowToContract(row) {
  return {
    patente: row.ppu,
    tipo: row.tipoVehiculo ?? null,
    marca: row.marca ?? null,
    modelo: row.modelo ?? null,
    anio: row.anioFabricacion ?? null,
    color: null,
    numeroMotor: row.numeroMotor ?? null,
    numeroChasis: row.numeroChasis ?? row.vin ?? null,
    combustible: row.combustible ?? null,
    kilometraje: row.kilometraje ?? null,
  };
}

const num = (v) => (v == null ? null : Number(v));

function rowToRevision(row) {
  return {
    numCertificado: row.numCertificado,
    fecRevision: row.fecRevision,
    fecVencimiento: row.fecVencimiento,
    resultadoCrt: row.resultadoCrt,
    kilometraje: row.kilometraje,
    planta: row.planta ?? null,
    estaciones: {
      identificacion: row.identificacion ?? null,
      visual: row.visual ?? null,
      luces: row.luces ?? null,
      alineacion: row.alineacion ?? null,
      frenos: row.frenos ?? null,
      holguras: row.holguras ?? null,
      suspension: row.suspension ?? null,
      gases: row.gases ?? null,
      opacidad: row.opacidad ?? null,
      anguloGiro: row.anguloGiro ?? null,
    },
    gases: {
      fecVencimientoGases: row.fecVencimientoGases ?? null,
      resultadoCrtGases: row.resultadoCrtGases ?? null,
      vCoRalenti: num(row.vCoRalenti), rCoRalenti: row.rCoRalenti ?? null,
      vHcRalenti: num(row.vHcRalenti), rHcRalenti: row.rHcRalenti ?? null,
      vCoco2Ralenti: num(row.vCoco2Ralenti), rCoco2Ralenti: row.rCoco2Ralenti ?? null,
      vCo2500: num(row.vCo2500), rCo2500: row.rCo2500 ?? null,
      vHc2500: num(row.vHc2500), rHc2500: row.rHc2500 ?? null,
      vCoco22500: num(row.vCoco22500), rCoco22500: row.rCoco22500 ?? null,
      vHcStdr5015: num(row.vHcStdr5015), rHcStdr5015: row.rHcStdr5015 ?? null,
      vCoStdr5015: num(row.vCoStdr5015), rCoStdr5015: row.rCoStdr5015 ?? null,
      vNoStdr5015: num(row.vNoStdr5015), rNoStdr5015: row.rNoStdr5015 ?? null,
      vHcStdr2525: num(row.vHcStdr2525), rHcStdr2525: row.rHcStdr2525 ?? null,
      vCoStdr2525: num(row.vCoStdr2525), rCoStdr2525: row.rCoStdr2525 ?? null,
      vNoStdr2525: num(row.vNoStdr2525), rNoStdr2525: row.rNoStdr2525 ?? null,
    },
    opacidad: {
      rHumo: row.rHumo ?? null,
      vOpa1: num(row.vOpa1), vOpa2: num(row.vOpa2), vOpa3: num(row.vOpa3),
      vOpa4: num(row.vOpa4), vOpa5: num(row.vOpa5),
      vValidaOpa: row.vValidaOpa ?? null,
      rOpaMedida: row.rOpaMedida ?? null,
    },
  };
}

// Historial completo de revisiones por PPU con mediciones (JOIN 1:1 detalle).
// Sin detalle → grupos en null (no inventa). Orden: fec_revision desc.
export async function getRevisiones(ppu) {
  const normalizada = normalizarPatente(ppu);
  if (!normalizada) throw new HttpError(422, 'patente_requerida');
  const rows = await query(
    `SELECT r.num_certificado AS numCertificado,
            r.fec_revision AS fecRevision, r.fec_vencimiento AS fecVencimiento,
            r.resultado_crt AS resultadoCrt, r.kilometraje, r.planta,
            d.identificacion, d.visual, d.luces, d.alineacion, d.frenos,
            d.holguras, d.suspension, d.gases, d.opacidad,
            d.angulo_giro AS anguloGiro,
            d.fec_vencimiento_gases AS fecVencimientoGases,
            d.resultado_crt_gases AS resultadoCrtGases,
            d.v_co_ralenti AS vCoRalenti, d.r_co_ralenti AS rCoRalenti,
            d.v_hc_ralenti AS vHcRalenti, d.r_hc_ralenti AS rHcRalenti,
            d.v_coco2_ralenti AS vCoco2Ralenti, d.r_coco2_ralenti AS rCoco2Ralenti,
            d.v_co_2500rpm AS vCo2500, d.r_co_2500rpm AS rCo2500,
            d.v_hc_2500rpm AS vHc2500, d.r_hc_2500rpm AS rHc2500,
            d.v_coco2_2500rpm AS vCoco22500, d.r_coco2_2500rpm AS rCoco22500,
            d.v_hc_stdr5015 AS vHcStdr5015, d.r_hc_stdr5015 AS rHcStdr5015,
            d.v_co_stdr5015 AS vCoStdr5015, d.r_co_stdr5015 AS rCoStdr5015,
            d.v_no_stdr5015 AS vNoStdr5015, d.r_no_stdr5015 AS rNoStdr5015,
            d.v_hc_stdr2525 AS vHcStdr2525, d.r_hc_stdr2525 AS rHcStdr2525,
            d.v_co_stdr2525 AS vCoStdr2525, d.r_co_stdr2525 AS rCoStdr2525,
            d.v_no_stdr2525 AS vNoStdr2525, d.r_no_stdr2525 AS rNoStdr2525,
            d.r_humo AS rHumo,
            d.v_opa1 AS vOpa1, d.v_opa2 AS vOpa2, d.v_opa3 AS vOpa3,
            d.v_opa4 AS vOpa4, d.v_opa5 AS vOpa5,
            d.v_valida_opa AS vValidaOpa, d.r_opa_medida AS rOpaMedida
       FROM prt_revision r
       LEFT JOIN prt_revision_detalle d ON d.revision_id = r.id
      WHERE r.ppu = :normalizada
      ORDER BY r.fec_revision DESC, r.id DESC`,
    { normalizada },
  );
  return rows.map(rowToRevision);
}
