// Seed diccionarios PRT → `prt_diccionario` (migracion 022).
//
// Lee los xlsx oficiales (ya descargados, archivos chicos: lectura simple):
//   Códigos_SGPRT.xlsx hoja 'Códigos_SGPRT' (NOMBRE_CATEGORIA/COD_TIPO/NOMBRE_TIPO)
//   Códigos_Plantas.xlsx hoja 'Hoja1' (Cód. Planta, Región, Comuna, Concesionario, Tipo)
// Códigos_Offline.xlsx solo se inspecciona para el reporte: NO se carga
// (esquemas por clase de planta que colisionan con SGPRT).
//
// Uso:
//   node scripts/seed-prt-diccionarios.js [--sgprt=/tmp/Codigos_SGPRT.xlsx]
//     [--plantas=/tmp/Codigos_Plantas.xlsx] [--offline=/tmp/Codigos_Offline.xlsx]
//     [--dry-run]
//   DB_* por entorno (mismo .env del api). En host: DB_HOST=127.0.0.1.
//
// Idempotente: upsert por UNIQUE(categoria, codigo); re-correr deja la tabla igual.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import ExcelJS from 'exceljs';

const CATEGORIAS_SGPRT = {
  'TIPO DE COMBUSTIBLE': 'combustible',
  'TIPO DE SERVICIO': 'servicio',
  'TIPO DE VEHÍCULO': 'vehiculo',
};

function str(v) {
  if (v == null) return '';
  return String(v).trim();
}

// Hoja 'Códigos_SGPRT': fila 1 titulo, fila 2 vacia, fila 3 cabecera,
// datos desde fila 4 (col B categoria, col C codigo, col D nombre).
async function leerSgprtAsync(xlsxPath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.getWorksheet('Códigos_SGPRT');
  if (!ws) throw new Error(`hoja_codigos_sgprt_ausente: ${xlsxPath}`);
  const entries = [];
  const omitidas = [];
  for (let r = 4; r <= ws.rowCount; r++) {
    const v = ws.getRow(r).values;
    const categoria = CATEGORIAS_SGPRT[str(v[1])];
    const codigo = str(v[2]);
    const nombre = str(v[3]);
    if (!categoria || !codigo || !nombre) {
      if (str(v[1]) || str(v[2]) || str(v[3])) omitidas.push(r);
      continue;
    }
    entries.push({ categoria, codigo, nombre });
  }
  return { entries, omitidas };
}

// Hoja 'Hoja1': fila 1 titulo, fila 2 vacia, fila 3 cabecera
// (col C codigo, col D region, col E comuna, col F concesionario),
// datos desde fila 4. Nombre: "CONCESIONARIO (COMUNA, REGIÓN N)".
async function leerPlantasAsync(xlsxPath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.getWorksheet('Hoja1');
  if (!ws) throw new Error(`hoja_plantas_ausente: ${xlsxPath}`);
  const entries = [];
  const conflictos = [];
  const vistos = new Map();
  let vacias = 0;
  for (let r = 4; r <= ws.rowCount; r++) {
    const v = ws.getRow(r).values;
    const codigo = str(v[2]);
    if (!codigo) {
      vacias++;
      continue;
    }
    const nombre = `${str(v[5])} (${str(v[4])}, REGIÓN ${str(v[3])})`;
    if (vistos.has(codigo)) {
      if (vistos.get(codigo) !== nombre) conflictos.push({ codigo, fila: r, previo: vistos.get(codigo), nuevo: nombre });
      continue;
    }
    vistos.set(codigo, nombre);
    entries.push({ categoria: 'planta', codigo, nombre });
  }
  return { entries, vacias, conflictos };
}

function parseArgs(argv) {
  const args = {
    sgprt: '/tmp/Codigos_SGPRT.xlsx',
    plantas: '/tmp/Codigos_Plantas.xlsx',
    offline: '/tmp/Codigos_Offline.xlsx',
    dryRun: false,
  };
  for (const a of argv) {
    if (a.startsWith('--sgprt=')) args.sgprt = a.split('=')[1];
    else if (a.startsWith('--plantas=')) args.plantas = a.split('=')[1];
    else if (a.startsWith('--offline=')) args.offline = a.split('=')[1];
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { entries: sgprt, omitidas } = await leerSgprtAsync(args.sgprt);
  const { entries: plantas, vacias, conflictos } = await leerPlantasAsync(args.plantas);
  const todas = [...sgprt, ...plantas];
  const porCategoria = {};
  for (const e of todas) porCategoria[e.categoria] = (porCategoria[e.categoria] ?? 0) + 1;

  const report = {
    sgprt: args.sgprt,
    plantas: args.plantas,
    porCategoria,
    filasSgprtOmitidas: omitidas,
    filasPlantasVacias: vacias,
    plantasDuplicadasEnConflicto: conflictos,
    offline: 'no cargado (esquemas por clase de planta; colisionan con SGPRT)',
    dryRun: args.dryRun,
    insertadas: 0,
  };

  if (!args.dryRun) {
    const pool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      database: process.env.DB_NAME || 'api_vehiculos',
      user: process.env.DB_USER || 'bit',
      password: process.env.DB_PASSWORD || 'bit',
      waitForConnections: true,
      connectionLimit: 2,
      dateStrings: true,
    });
    try {
      const placeholders = todas.map(() => '(?, ?, ?)').join(',');
      const params = [];
      for (const e of todas) params.push(e.categoria, e.codigo, e.nombre);
      const [res] = await pool.query(
        `INSERT INTO prt_diccionario (categoria, codigo, nombre)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE nombre = VALUES(nombre)`,
        params,
      );
      report.insertadas = res.affectedRows ?? 0;
      const [rows] = await pool.query(
        `SELECT categoria, COUNT(*) AS n FROM prt_diccionario GROUP BY categoria ORDER BY categoria`,
      );
      report.enTabla = Object.fromEntries(rows.map((r) => [r.categoria, Number(r.n)]));
    } finally {
      await pool.end();
    }
  }
  console.log(`[prt-dict] reporte: ${JSON.stringify(report)}`);
}

const isMain = process.argv[1] && process.argv[1].endsWith('seed-prt-diccionarios.js');
if (isMain) {
  main().catch((err) => {
    console.error(`[prt-dict] error: ${err.message}`);
    process.exit(1);
  });
}
