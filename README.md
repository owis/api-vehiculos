# api-vehiculos

Servicio autónomo de **consulta vehicular** de bit. Resuelve información de una
patente contra **PRT local (open data prt.cl) + caché propia**, con fallback
manual. No navega, no scrapea patentechile.com, no encola workers.

bit lo consume por HTTP como `api-vehiculos.creceideas.cl`. La persistencia de
negocio (qué vehículo pertenece a qué empresa) vive en bit; este servicio es el
resolutor de datos de patente.

## Responsabilidad

- Resolver una PPU: **caché → PRT local → fallback manual** (solo lectura).
- Exponer el historial de revisiones PRT con mediciones (estaciones, gases, opacidad).
- Guardar la caché de resolución **solo cuando el consumidor lo pide** (endpoint explícito).
- Tener su propia ingesta PRT (`scripts/ingest-prt.js`) y su propia BD (`api_vehiculos`).

**No** hace: autenticación de usuarios, multi-tenancy, CRUD de vehículos de empresa,
documentos/seguros/permisos/mantenimientos, ni scraping con navegador.

## Endpoints

Todos requieren `X-Api-Key` (salvo `/health`).

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/health` | Liveness. |
| GET | `/vehiculos/:ppu` | Resuelve la PPU (contrato 10 campos). `?force=true` salta la caché fresca. |
| GET | `/vehiculos/:ppu/revisiones` | Historial PRT con mediciones por certificado. |
| GET | `/vehiculos/lookup-local/:ppu` | Última revisión PRT mapeada. 404 si no existe. |
| POST | `/vehiculos/consultas` | Persiste la caché de la PPU (guardado explícito). |

### Contrato de resolución (10 campos)

`patente, tipo, marca, modelo, anio, color, numeroMotor, numeroChasis, combustible, kilometraje`

`color` siempre vuelve `null` (manual-only en bit). Ausentes quedan `null`; nunca se inventa.
Cada respuesta incluye `origen` (`cache` | `prt-local` | `manual`) y `manualEntry`.

## Variables de entorno

| Variable | Default | Descripción |
| --- | --- | --- |
| `NODE_ENV` | `development` | Entorno. |
| `API_VEHICULOS_PORT` | `3100` | Puerto HTTP. |
| `API_VEHICULOS_API_KEY` | (vacío) | Clave servicio-a-servicio; bit la envía en `X-Api-Key`. Vacío ⇒ rechaza todo. |
| `API_VEHICULOS_ALLOW_ANON` | `false` | Solo dev/test: permite tráfico sin API key configurada. |
| `DB_HOST` | `127.0.0.1` | Host MySQL. |
| `DB_PORT` | `3306` | Puerto MySQL. |
| `DB_NAME` | `api_vehiculos` | Base de datos propia del servicio. |
| `DB_USER` | `bit` | Usuario. |
| `DB_PASSWORD` | `bit` | Password. |
| `API_VEHICULOS_CACHE_TTL_DAYS` | `30` | TTL de la caché de resoluciones. |
| `PRT_BASE_URL` | `https://www.prt.cl/Descargas/docs/2026/1.Enero` | Base de descarga de la ingesta PRT. |
| `API_VEHICULOS_CORS_ORIGIN` | (vacío) | CORS para llamadas browser directas (opcional). |

## Puesta en marcha

```bash
# 1. Dependencias
npm install

# 2. Crear la BD (una vez)
mysql -e "CREATE DATABASE IF NOT EXISTS api_vehiculos CHARACTER SET utf8mb4;"

# 3. Aplicar migraciones (idempotente)
npm run migrate

# 4. Cargar diccionarios PRT (requiere los xlsx oficiales)
npm run seed:prt -- --sgprt=/tmp/Codigos_SGPRT.xlsx --plantas=/tmp/Codigos_Plantas.xlsx

# 5. Ingesta PRT del periodo (descarga o usa zips locales en --dir)
npm run ingest:prt -- --periodo=202601

# 6. Levantar
npm run dev
```

## Consumo desde bit

bit llama a este servicio con `API_VEHICULOS_URL` + `API_VEHICULOS_API_KEY`.
El resolver de bit ya no encola al worker de patentechile.com: consulta este
servicio y persiste el vehículo solo al guardar/refrescar.
