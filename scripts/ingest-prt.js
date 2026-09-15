// Ingesta piloto PRT open data (prt.cl) → `prt_revision`.
//
// Diseno (openspec/changes/prt-lookup-local, PR 2): descarga los zips
// mensuales RA1+RA2+RB, extrae el xlsx con `unzipper` en streaming y lo
// parsea fila por fila con `exceljs` WorkbookReader (jamas full-load: solo
// el batch activo vive en memoria). Upsert idempotente por
// UNIQUE(ppu, num_certificado); re-correr los mismos archivos deja la tabla
// igual (affectedRows 0 en filas identicas: MySQL no toca updated_at si
// ningun valor cambia).
//
// Uso:
//   npm run ingest:prt -- --periodo=202601 [--dir=/tmp/prt_data] [--batch=1000]
//                      [--solo=RB] [--skip-download] [--metodo=bulk|filas]
//   --metodo=bulk (default): xlsx→TSV→LOAD DATA LOCAL INFILE→INSERT...SELECT.
//   --metodo=filas: vía legada fila-a-fila (fallback).
//   DB_* por entorno (mismo .env del api). En host: DB_HOST=127.0.0.1.
//
// Columnas mapeadas (nucleo comun RA1/RA2/RB; resto de columnas de gases,
// frenos, etc. se ignoran en el piloto):
//   PPU MARCA MODELO ANO_FABRICACION NUM_MOTOR NUM_CHASIS VIN KILOMETRAJE
//   NUM_CERTIFICADO FEC_REVISION FEC_VENCIMIENTO RESULTADO_CRT
//   COD_COMBUSTIBLE COD_SERVICIO COD_VEHICULO COD_PRT(planta) + periodo YYYYMM.
import 'dotenv/config';
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import https, { get as httpsGet } from 'node:https';
const httpsAgent = https.Agent;
import { get as httpGet } from 'node:http';
import { basename, join } from 'node:path';
import mysql from 'mysql2/promise';
import ExcelJS from 'exceljs';
import unzipper from 'unzipper';

export const PILOTO_DATASETS = ['RA1', 'RA2', 'RB'];
export const BASE_URL_DEFAULT = 'https://www.prt.cl/Descargas/docs/2026/1.Enero';

export function normalizarPpu(ppu) {
  return String(ppu ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function cleanStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toUpperCase() === 'NULL') return null;
  return s;
}

function cleanVin(v) {
  const s = cleanStr(v);
  if (!s || s === '0') return null;
  return s;
}

export function toIntOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // Guarda anti-basura: INT MySQL (±2.1e9). Seriales absurdos → NULL
  // (evita "Out of range value" en LOAD/INSERT estricto).
  if (Math.abs(n) > 2147483647) return null;
  return Math.trunc(n);
}

function toDateOnlyRaw(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Serial Excel (dias desde 1899-12-30).
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

// Validador estricto de fecha calendario: años 1900–2100, mes 01–12, día
// real (incluye bisiestos). Los xlsx viejos traen seriales corruptos que
// exceljs entrega como Date año 60000+ ("+067805-08") o textos mes-13:
// sin esto MySQL rechaza todo el batch con "Incorrect date value".
export function toDateOnly(v) {
  const out = toDateOnlyRaw(v);
  if (!out) return null;
  const m = out.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const chk = new Date(Date.UTC(y, mo - 1, d));
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
  return out;
}

export function toTimeOrNull(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(11, 19);
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Fraccion de dia Excel (0.5 = mediodia); seriales >= 1 usan la fraccion.
    const frac = ((v % 1) + 1) % 1;
    const secs = Math.round(frac * 86400);
    const h = String(Math.floor(secs / 3600)).padStart(2, '0');
    const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] == null ? 0 : Number(m[3]);
  if (h > 23 || min > 59 || sec > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function toDecimalOrNull(v, maxAbs = 99999999.9999) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // Guarda anti-basura: DECIMAL(12,4) del detalle. Seriales absurdos de
  // xlsx viejos → NULL en vez de "Out of range value".
  if (Math.abs(n) > maxAbs) return null;
  return n;
}

// Indice header-name (upper) -> posicion 1-based en row.values.
export function buildHeaderIndex(headerValues) {  const idx = new Map();
  for (let i = 1; i < headerValues.length; i++) {
    const name = String(headerValues[i] ?? '').trim().toUpperCase();
    if (name && !idx.has(name)) idx.set(name, i);
  }
  return idx;
}

const col = (values, idx, ...names) => {
  for (const n of names) {
    const i = idx.get(n);
    if (i != null && values[i] != null) return values[i];
  }
  return null;
};

export function mapRowToRecord(values, idx, periodo) {
  const ppu = normalizarPpu(col(values, idx, 'PPU'));
  const numCertificado = cleanStr(col(values, idx, 'NUM_CERTIFICADO'));
  if (!ppu || !numCertificado) return null;
  return {
    ppu,
    num_certificado: numCertificado,
    periodo,
    marca: cleanStr(col(values, idx, 'MARCA')),
    modelo: cleanStr(col(values, idx, 'MODELO')),
    anio_fabricacion: toIntOrNull(col(values, idx, 'ANO_FABRICACION', 'AÑO_FABRICACION')),
    numero_motor: cleanStr(col(values, idx, 'NUM_MOTOR')),
    numero_chasis: cleanStr(col(values, idx, 'NUM_CHASIS')),
    vin: cleanVin(col(values, idx, 'VIN')),
    kilometraje: toIntOrNull(col(values, idx, 'KILOMETRAJE', 'KM')),
    fec_revision: toDateOnly(col(values, idx, 'FEC_REVISION')),
    fec_vencimiento: toDateOnly(col(values, idx, 'FEC_VENCIMIENTO')),
    resultado_crt: cleanStr(col(values, idx, 'RESULTADO_CRT')),
    planta: cleanStr(col(values, idx, 'COD_PRT', 'PLANTA')),
    cod_combustible: cleanStr(col(values, idx, 'COD_COMBUSTIBLE')),
    cod_servicio: cleanStr(col(values, idx, 'COD_SERVICIO')),
    cod_vehiculo: cleanStr(col(values, idx, 'COD_VEHICULO')),
  };
}

const UPSERT_COLS = [
  'ppu', 'num_certificado', 'periodo', 'marca', 'modelo', 'anio_fabricacion',
  'numero_motor', 'numero_chasis', 'vin', 'kilometraje', 'fec_revision',
  'fec_vencimiento', 'resultado_crt', 'planta', 'cod_combustible', 'cod_servicio',
  'cod_vehiculo',
];
const UPDATE_COLS = UPSERT_COLS.filter((c) => c !== 'ppu' && c !== 'num_certificado');

export async function upsertBatch(conn, records) {
  if (!records.length) return 0;
  const placeholders = records.map(() => `(${UPSERT_COLS.map(() => '?').join(',')})`).join(',');
  const params = [];
  for (const r of records) for (const c of UPSERT_COLS) params.push(r[c] ?? null);
  const setSql = UPDATE_COLS.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');
  const [res] = await conn.query(
    `INSERT INTO prt_revision (${UPSERT_COLS.map((c) => `\`${c}\``).join(', ')})
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE ${setSql}`,
    params,
  );
  return res.affectedRows ?? 0;
}

// Detalle 1:1 (migration 023): 46 columnas de medicion del set comun RA2.
// RA1-only (RUIDOS, V_OPA_CARGA, R_OPA_CARGA) fuera de diseno.
export const DETALLE_COLS = [
  'hora_ini', 'hora_fin', 'fec_vencimiento_gases', 'resultado_crt_gases',
  'identificacion', 'visual', 'luces', 'alineacion', 'frenos', 'holguras',
  'suspension', 'gases', 'opacidad', 'angulo_giro',
  'v_co_ralenti', 'r_co_ralenti', 'v_hc_ralenti', 'r_hc_ralenti',
  'v_coco2_ralenti', 'r_coco2_ralenti', 'v_co_2500rpm', 'r_co_2500rpm',
  'v_hc_2500rpm', 'r_hc_2500rpm', 'v_coco2_2500rpm', 'r_coco2_2500rpm',
  'v_hc_stdr5015', 'r_hc_stdr5015', 'v_co_stdr5015', 'r_co_stdr5015',
  'v_no_stdr5015', 'r_no_stdr5015', 'v_hc_stdr2525', 'r_hc_stdr2525',
  'v_co_stdr2525', 'r_co_stdr2525', 'v_no_stdr2525', 'r_no_stdr2525',
  'r_humo', 'v_opa1', 'v_opa2', 'v_opa3', 'v_opa4', 'v_opa5',
  'v_valida_opa', 'r_opa_medida',
];

const V_DECIMAL = new Set(DETALLE_COLS.filter((c) => c.startsWith('v_') && c !== 'v_valida_opa'));

export function mapRowToDetalle(values, idx) {
  const rec = {
    ppu: normalizarPpu(col(values, idx, 'PPU')),
    num_certificado: cleanStr(col(values, idx, 'NUM_CERTIFICADO')),
  };
  for (const c of DETALLE_COLS) {
    const raw = col(values, idx, c.toUpperCase());
    if (c === 'hora_ini' || c === 'hora_fin') rec[c] = toTimeOrNull(raw);
    else if (c === 'fec_vencimiento_gases') rec[c] = toDateOnly(raw);
    else if (V_DECIMAL.has(c)) rec[c] = toDecimalOrNull(raw);
    else rec[c] = cleanStr(raw);
  }
  return rec;
}

// Upsert chunked del detalle: resuelve revision_id por UK en una query y
// hace bulk INSERT ... ON DUPLICATE KEY UPDATE. Huerfanos → `skipped`.
export async function upsertBatchDetalle(conn, records) {
  if (!records.length) return { upserted: 0, skipped: 0 };
  const where = records.map(() => '(ppu = ? AND num_certificado = ?)').join(' OR ');
  const params = records.flatMap((r) => [r.ppu, r.num_certificado]);
  const [parents] = await conn.query(
    `SELECT id, ppu, num_certificado FROM prt_revision WHERE ${where}`,
    params,
  );
  const idByKey = new Map(parents.map((p) => [`${p.ppu}|${p.num_certificado}`, p.id]));
  const rows = [];
  let skipped = 0;
  for (const r of records) {
    const id = idByKey.get(`${r.ppu}|${r.num_certificado}`);
    if (id == null) {
      skipped++;
      continue;
    }
    rows.push([id, ...DETALLE_COLS.map((c) => r[c] ?? null)]);
  }
  if (!rows.length) return { upserted: 0, skipped };
  const cols = ['revision_id', ...DETALLE_COLS];
  const placeholders = rows.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
  const setSql = DETALLE_COLS.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');
  await conn.query(
    `INSERT INTO prt_revision_detalle (${cols.map((c) => `\`${c}\``).join(', ')})
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE ${setSql}`,
    rows.flat(),
  );
  return { upserted: rows.length, skipped };
}

// Huella del detalle de un periodo (JOIN al padre). Con checksumPeriodo
// forma el checksum dual: re-correr deja ambos iguales.
export async function checksumDetalle(conn, periodo) {
  const sumExpr = ['d.revision_id', ...DETALLE_COLS.map((c) => `d.\`${c}\``)]
    .map((e) => `IFNULL(${e},'')`)
    .join(', ');
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CRC32(CONCAT_WS('|', ${sumExpr}))), 0) AS chk
       FROM prt_revision_detalle d JOIN prt_revision r ON r.id = d.revision_id
      WHERE r.periodo = ?`,
    [periodo],
  );
  return { n: Number(rows[0].n), chk: String(rows[0].chk) };
}

// Huella agregada del contenido (columnas de datos) de un periodo.
// Idempotencia real: re-correr los mismos archivos deja COUNT y checksum
// iguales (mysql2 reporta affectedRows "found-rows", no sirve como senal;
// a nivel storage MySQL no toca updated_at si ningun valor cambia).
export async function checksumPeriodo(conn, periodo) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n,
       COALESCE(SUM(CRC32(CONCAT_WS('|', ppu, num_certificado, periodo,
         IFNULL(marca,''), IFNULL(modelo,''), IFNULL(anio_fabricacion,''),
         IFNULL(numero_motor,''), IFNULL(numero_chasis,''), IFNULL(vin,''),
         IFNULL(kilometraje,''), IFNULL(fec_revision,''),
         IFNULL(fec_vencimiento,''), IFNULL(resultado_crt,''),
          IFNULL(planta,''), IFNULL(cod_combustible,''),
          IFNULL(cod_servicio,''), IFNULL(cod_vehiculo,'')))), 0) AS chk
      FROM prt_revision WHERE periodo = ?`,
    [periodo],
  );
  return { n: Number(rows[0].n), chk: String(rows[0].chk) };
}

function rssMB() {
  return process.memoryUsage().rss / 1024 / 1024;
}

// Parsea un xlsx en streaming real (WorkbookReader: fila por fila, sin
// modelo en memoria) y entrega batches al sink. Retorna { filas, batches }.
export async function ingestWorkbook(xlsxPath, { periodo, batchSize = 1000, sink, onProgress } = {}) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(xlsxPath, {
    entries: 'emit',
    sharedStrings: 'cache',
    worksheets: 'emit',
  });
  let filas = 0;
  let batches = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const chunk = batch;
    batch = [];
    batches++;
    await sink(chunk);
  };
  for await (const ws of workbook) {
    let headerIdx = null;
    for await (const row of ws) {
      if (row.number === 1) {
        headerIdx = buildHeaderIndex(row.values);
        if (!headerIdx.has('PPU') || !headerIdx.has('NUM_CERTIFICADO')) {
          throw new Error(`cabecera_sin_ppu_o_certificado: ${xlsxPath}`);
        }
        continue;
      }
      const rec = mapRowToRecord(row.values, headerIdx, periodo);
      if (!rec) continue;
      rec.detalle = mapRowToDetalle(row.values, headerIdx);
      batch.push(rec);
      filas++;
      if (batch.length >= batchSize) await flush();
      if (onProgress && filas % 50000 === 0) onProgress({ filas, rssMB: rssMB() });
    }
    await flush();
  }
  return { filas, batches };
}

function downloadFile(url, destPath) {
  const agent = url.startsWith('https:') ? new httpsAgent({ rejectUnauthorized: false }) : undefined;
  const getter = url.startsWith('https:') ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    getter(url, { agent }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadFile(new URL(res.headers.location, url).toString(), destPath).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`descarga_http_${res.statusCode}: ${url}`));
        return;
      }
      pipeline(res, createWriteStream(destPath)).then(resolve, reject);
    }).on('error', reject);
  });
}

async function extractXlsx(zipPath, xlsxPath) {
  const dir = await unzipper.Open.file(zipPath);
  const entry = dir.files.find((f) => f.path.toLowerCase().endsWith('.xlsx'));
  if (!entry) throw new Error(`zip_sin_xlsx: ${zipPath}`);
  await pipeline(entry.stream(), createWriteStream(xlsxPath));
}

// Resuelve el xlsx local de un dataset: reutiliza el existente, si no
// extrae del zip local, si no descarga el zip de prt.cl. Retorna la ruta.
// Mapea periodo YYYYMM → sufijo de mes del nombre de archivo (ej. 202510 → 'oct-2025').
const MESES_CORTO = { '01': 'ene', '02': 'feb', '03': 'mar', '04': 'abr', '05': 'may', '06': 'jun', '07': 'jul', '08': 'ago', '09': 'sep', '10': 'oct', '11': 'nov', '12': 'dic' };
export function sufijoMesPeriodo(periodo) {
  const anio = String(periodo).slice(0, 4);
  const mes = MESES_CORTO[String(periodo).slice(4, 6)] || '';
  return `${mes}-${anio}`;
}

// Backfill: acepta cualquier zip local `SGPRT_{KEY}[_-]*.zip` (el nombre
// varia por mes: `SGPRT_RA1_oct-2025.zip`, `SGPRT_RA1-dic-2025.zip`, ...);
// solo usa el nombre legacy `ene-2026` como ultimo recurso de descarga.
//
// IMPORTANTE (fix backfill): selecciona el zip cuyo nombre contiene el mes
// del `periodo` objetivo (match exacto `SGPRT_{KEY}[_-]{mes}-{anio}.zip`), y
// extrae a un xlsx derivado de ESE zip. Nunca reutiliza un xlsx genérico del
// mismo prefijo que pueda pertenecer a otro mes (reutilizar enero en todos
// los periodos corrompió el backfill con datos de enero re-etiquetados).
export async function resolveDatasetFile({ key, dir, baseUrl, skipDownload, periodo }) {
  const { readdirSync } = await import('node:fs');
  const prefijos = [`SGPRT_${key}_`, `SGPRT_${key}-`];
  const sufijo = sufijoMesPeriodo(periodo);
  const zips = existsSync(dir)
    ? readdirSync(dir).filter((f) => {
      const u = f.toUpperCase();
      return prefijos.some((p) => u.startsWith(p)) && f.toLowerCase().endsWith('.zip');
    })
    : [];
  // Zip cuyo nombre contiene el mes+año del periodo; sin match no reciclar otro mes.
  // Si el zip del periodo no está local, se construye el nombre canónico y se descarga.
  // Además, si existe un xlsx huérfano del periodo sin su zip (caso ene-2026 legacy),
  // se reutiliza directamente sin forzar descarga.
  const match = zips.find((f) => f.toUpperCase().includes(sufijo.toUpperCase()));
  const canonicalZip = `SGPRT_${key}_${sufijo}.zip`;
  const canonicalXlsx = join(dir, canonicalZip.replace('.zip', '.xlsx'));
  if (!match && existsSync(canonicalXlsx)) return canonicalXlsx;
  const zipName = match ?? canonicalZip;
  const zipPath = join(dir, zipName);
  if (!existsSync(zipPath)) {
    if (skipDownload) throw new Error(`archivo_ausente_sin_descarga: ${zipName}`);
    mkdirSync(dir, { recursive: true });
    console.log(`[prt] descargando ${zipName} ...`);
    await downloadFile(`${baseUrl}/${zipName}`, zipPath);
  }
  // xlsx derivado del zip del periodo (único). Reutilizar solo si ya se extrajo.
  const direct = join(dir, zipName.replace('.zip', '.xlsx'));
  if (existsSync(direct)) return direct;
  console.log(`[prt] extrayendo ${zipName} ...`);
  await extractXlsx(zipPath, direct);
  return direct;
}

// ============================================================
// VIA BULK (default --metodo=bulk): xlsx → TSV en disco →
//   LOAD DATA LOCAL INFILE a staging → INSERT...SELECT a final.
// Evita ~1.4M upserts fila-a-fila por periodo (~×10–20 más rápido,
// RAM mínima). Semántica idéntica a la vía filas: last-wins por
// (ppu, num_certificado), detalle huérfano omitido+contado.
// Staging se deriva de las tablas finales (CTAS, sin llaves) + columna
// seq para dedup "última fila del archivo gana".
// ============================================================
function tsvCell(v) {
  if (v == null) return '\\N';
  return String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}
function tsvLine(vals) {
  return vals.map(tsvCell).join('\t') + '\n';
}

async function ensureStaging(pool) {
  await pool.query('CREATE TABLE IF NOT EXISTS stg_prt_revision AS SELECT * FROM prt_revision WHERE 1=0');
  await pool.query('CREATE TABLE IF NOT EXISTS stg_prt_detalle AS SELECT * FROM prt_revision_detalle WHERE 1=0');
  const alters = [
    ['stg_prt_revision', 'ADD COLUMN seq BIGINT AUTO_INCREMENT PRIMARY KEY FIRST'],
    ['stg_prt_detalle', 'ADD COLUMN seq BIGINT AUTO_INCREMENT PRIMARY KEY FIRST'],
    ['stg_prt_detalle', 'ADD COLUMN ppu VARCHAR(12) NULL'],
    ['stg_prt_detalle', 'ADD COLUMN num_certificado VARCHAR(64) NULL'],
  ];
  for (const [t, ddl] of alters) {
    try {
      await pool.query(`ALTER TABLE \`${t}\` ${ddl}`);
    } catch (e) {
      if (e.errno !== 1060) throw e; // columna ya existe: ok
    }
  }
}

async function ingestDatasetBulk({ dir, periodo, xlsxPath, key, pool, batchSize, onProgress, verbose }) {
  const t0 = Date.now();
  const revPath = join(dir, `stg_${periodo}_${key}_rev.tsv`);
  const detPath = join(dir, `stg_${periodo}_${key}_det.tsv`);
  const revOut = createWriteStream(revPath);
  const detOut = createWriteStream(detPath);
  let filas = 0;
  try {
    await ingestWorkbook(xlsxPath, {
      periodo,
      batchSize,
      sink: async (chunk) => {
        for (const r of chunk) {
          if (!revOut.write(tsvLine(UPSERT_COLS.map((c) => r[c] ?? null)))) await once(revOut, 'drain');
          const d = r.detalle || {};
          const detVals = [d.ppu ?? null, d.num_certificado ?? null, ...DETALLE_COLS.map((c) => d[c] ?? null)];
          if (!detOut.write(tsvLine(detVals))) await once(detOut, 'drain');
          filas++;
          if (onProgress && filas % 50000 === 0) onProgress({ filas, rssMB: rssMB() });
        }
      },
    });
    revOut.end();
    detOut.end();
    await Promise.all([once(revOut, 'finish'), once(detOut, 'finish')]);

    await ensureStaging(pool);
    await pool.query('TRUNCATE TABLE stg_prt_revision');
    await pool.query('TRUNCATE TABLE stg_prt_detalle');
    const q = (p) => `'${String(p).replace(/'/g, "''")}'`;
    if (verbose) console.log(`[bulk:${key}] LOAD ${filas} filas a staging…`);
    await pool.query(`LOAD DATA LOCAL INFILE ${q(revPath)} INTO TABLE stg_prt_revision (${UPSERT_COLS.map((c) => `\`${c}\``).join(',')})`);
    await pool.query(`LOAD DATA LOCAL INFILE ${q(detPath)} INTO TABLE stg_prt_detalle (\`ppu\`,\`num_certificado\`,${DETALLE_COLS.map((c) => `\`${c}\``).join(',')})`);

    const revCols = UPSERT_COLS.map((c) => `\`${c}\``).join(', ');
    const revSel = UPSERT_COLS.map((c) => `s.\`${c}\``).join(', ');
    const revUpd = UPDATE_COLS.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');
    const [r1] = await pool.query(
      `INSERT INTO prt_revision (${revCols}) ` +
      `SELECT ${revSel} FROM stg_prt_revision s ` +
      `JOIN (SELECT MAX(seq) mseq FROM stg_prt_revision GROUP BY ppu, num_certificado) d ON d.mseq = s.seq ` +
      `ON DUPLICATE KEY UPDATE ${revUpd}`);

    const detCols = DETALLE_COLS.map((c) => `\`${c}\``).join(', ');
    const detSel = DETALLE_COLS.map((c) => `s.\`${c}\``).join(', ');
    const detUpd = DETALLE_COLS.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');
    const dedupDet = `stg_prt_detalle s JOIN (SELECT MAX(seq) mseq FROM stg_prt_detalle GROUP BY ppu, num_certificado) d ON d.mseq = s.seq`;
    const [r2] = await pool.query(
      `INSERT INTO prt_revision_detalle (revision_id, ${detCols}) ` +
      `SELECT r.id, ${detSel} FROM ${dedupDet} ` +
      `JOIN prt_revision r ON r.ppu = s.ppu AND r.num_certificado = s.num_certificado ` +
      `ON DUPLICATE KEY UPDATE ${detUpd}`);
    const [[{ h }]] = await pool.query(
      `SELECT COUNT(*) h FROM ${dedupDet} LEFT JOIN prt_revision r ON r.ppu = s.ppu AND r.num_certificado = s.num_certificado WHERE r.id IS NULL`);
    return {
      filas, batches: 3, affected: r1.affectedRows ?? 0,
      detUpserted: r2.affectedRows ?? 0, detSkipped: Number(h),
      elapsedMs: Date.now() - t0,
    };
  } finally {
    for (const p of [revPath, detPath]) {
      try {
        await unlink(p);
      } catch { /* ya limpiado */ }
    }
  }
}

function parseArgs(argv) {
  const args = { periodo: '202601', dir: '/tmp/prt_data', batch: 1000, solo: null, skipDownload: false, baseUrl: BASE_URL_DEFAULT, metodo: 'bulk' };
  for (const a of argv) {
    if (a.startsWith('--periodo=')) args.periodo = a.split('=')[1];
    else if (a.startsWith('--dir=')) args.dir = a.split('=')[1];
    else if (a.startsWith('--batch=')) args.batch = Number(a.split('=')[1]) || 1000;
    else if (a.startsWith('--solo=')) args.solo = a.split('=')[1].toUpperCase();
    else if (a === '--skip-download') args.skipDownload = true;
    else if (a.startsWith('--metodo=')) args.metodo = a.split('=')[1] === 'filas' ? 'filas' : 'bulk';
    else if (a.startsWith('--base-url=')) args.baseUrl = a.split('=')[1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const keys = args.solo ? [args.solo] : [...PILOTO_DATASETS];
  for (const k of keys) {
    if (!PILOTO_DATASETS.includes(k)) throw new Error(`dataset_invalido: ${k} (RA1|RA2|RB)`);
  }
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || 'api_vehiculos',
    user: process.env.DB_USER || 'bit',
    password: process.env.DB_PASSWORD || 'bit',
    waitForConnections: true,
    connectionLimit: 2,
    infileStreamFactory: (path) => createReadStream(path),
    dateStrings: true,
  });
  const t0 = Date.now();
  let peakRss = rssMB();
  try {
    const antes = await checksumPeriodo(pool, args.periodo);
    const antesDetalle = await checksumDetalle(pool, args.periodo);
    const archivos = [];
    let totalFilas = 0;
    let totalAffected = 0;
    let totalDetalle = 0;
    let totalHuerfanos = 0;
    for (const key of keys) {
      const xlsxPath = await resolveDatasetFile({ key, dir: args.dir, baseUrl: args.baseUrl, skipDownload: args.skipDownload, periodo: args.periodo });
      console.log(`[prt] ${key}: ${basename(xlsxPath)}`);
      if (args.metodo === 'bulk') {
        const r = await ingestDatasetBulk({
          dir: args.dir, periodo: args.periodo, xlsxPath, key, pool,
          batchSize: args.batch, verbose: true,
          onProgress: ({ filas: f, rssMB: rss }) => {
            if (rss > peakRss) peakRss = rss;
            console.log(`[prt] ${key}: ${f} filas TSV, RSS ${rss.toFixed(0)} MB`);
          },
        });
        totalFilas += r.filas;
        totalAffected += r.affected;
        totalDetalle += r.detUpserted;
        totalHuerfanos += r.detSkipped;
        const rss = rssMB();
        if (rss > peakRss) peakRss = rss;
        archivos.push({ dataset: key, archivo: basename(xlsxPath), filas: r.filas, batches: r.batches, metodo: 'bulk' });
        console.log(`[prt] ${key}: ${r.filas} filas bulk en ${r.elapsedMs} ms`);
        continue;
      }
      const { filas, batches } = await ingestWorkbook(xlsxPath, {
        periodo: args.periodo,
        batchSize: args.batch,
        sink: async (chunk) => {
          const affected = await upsertBatch(pool, chunk);
          totalAffected += affected;
          const det = await upsertBatchDetalle(
            pool,
            chunk.map((c) => ({ ppu: c.ppu, num_certificado: c.num_certificado, ...c.detalle })),
          );
          totalDetalle += det.upserted;
          totalHuerfanos += det.skipped;
          const rss = rssMB();
          if (rss > peakRss) peakRss = rss;
        },
        onProgress: ({ filas: f, rssMB: rss }) => {
          if (rss > peakRss) peakRss = rss;
          console.log(`[prt] ${key}: ${f} filas, RSS ${rss.toFixed(0)} MB`);
        },
      });
      totalFilas += filas;
      archivos.push({ dataset: key, archivo: basename(xlsxPath), filas, batches });
      console.log(`[prt] ${key}: ${filas} filas en ${batches} batches`);
    }
    const despues = await checksumPeriodo(pool, args.periodo);
    const despuesDetalle = await checksumDetalle(pool, args.periodo);
    const delta = despues.n - antes.n;
    const deltaDetalle = despuesDetalle.n - antesDetalle.n;
    const sinCambios =
      delta === 0 && antes.chk === despues.chk &&
      deltaDetalle === 0 && antesDetalle.chk === despuesDetalle.chk;
    const report = {
      periodo: args.periodo,
      archivos,
      totalFilas,
      tablaAntes: antes.n,
      tablaDespues: despues.n,
      filasNuevas: delta,
      checksumAntes: antes.chk,
      checksumDespues: despues.chk,
      detalleAntes: antesDetalle.n,
      detalleDespues: despuesDetalle.n,
      detalleNuevas: deltaDetalle,
      checksumDetalleAntes: antesDetalle.chk,
      checksumDetalleDespues: despuesDetalle.chk,
      detalleUpserts: totalDetalle,
      detalleHuerfanos: totalHuerfanos,
      sinCambios,
      affectedRowsBruto: totalAffected, // señal cliente found-rows: solo informativa
      peakRssMB: Math.round(peakRss),
      elapsedMs: Date.now() - t0,
    };
    console.log(`[prt] reporte: ${JSON.stringify(report)}`);
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] && basename(process.argv[1]) === 'ingest-prt.js';
if (isMain) {
  main().catch((err) => {
    console.error(`[prt] error: ${err.message}`);
    process.exit(1);
  });
}
