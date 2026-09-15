-- =============================================================================
-- api-vehiculos — Schema inicial (BD propia `api_vehiculos`)
-- =============================================================================
-- Servicio autónomo de consulta vehicular. Datos globales (PRT es open data
-- público y plate-scoped, no multi-tenant). Sin empresa_id.
--
-- Tablas:
--   prt_revision            — una fila por certificado PRT (fuente: prt.cl)
--   prt_revision_detalle    — 1:1 con prt_revision: estaciones + gases/opacidad
--   prt_diccionario         — códigos oficiales PRT (combustible/servicio/vehículo/planta)
--   vehiculo_consulta       — caché de resoluciones por PPU (marca/modelo/...)
--
-- Idempotente: CREATE TABLE IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `prt_revision` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `ppu` VARCHAR(12) NOT NULL,
  `num_certificado` VARCHAR(50) NOT NULL,
  `periodo` CHAR(6) NOT NULL,
  `marca` VARCHAR(100) NULL,
  `modelo` VARCHAR(100) NULL,
  `anio_fabricacion` INT NULL,
  `numero_motor` VARCHAR(100) NULL,
  `numero_chasis` VARCHAR(100) NULL,
  `vin` VARCHAR(50) NULL,
  `kilometraje` INT NULL,
  `fec_revision` DATE NULL,
  `fec_vencimiento` DATE NULL,
  `resultado_crt` VARCHAR(20) NULL,
  `planta` VARCHAR(100) NULL,
  `cod_combustible` VARCHAR(10) NULL,
  `cod_servicio` VARCHAR(10) NULL,
  `cod_vehiculo` VARCHAR(10) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_prt_ppu_cert` (`ppu`, `num_certificado`),
  INDEX `idx_prt_ppu` (`ppu`)
);

CREATE TABLE IF NOT EXISTS `prt_revision_detalle` (
  `revision_id` INT PRIMARY KEY,
  `hora_ini` TIME NULL,
  `hora_fin` TIME NULL,
  `fec_vencimiento_gases` DATE NULL,
  `resultado_crt_gases` VARCHAR(20) NULL,
  `identificacion` VARCHAR(10) NULL,
  `visual` VARCHAR(10) NULL,
  `luces` VARCHAR(10) NULL,
  `alineacion` VARCHAR(10) NULL,
  `frenos` VARCHAR(10) NULL,
  `holguras` VARCHAR(10) NULL,
  `suspension` VARCHAR(10) NULL,
  `gases` VARCHAR(10) NULL,
  `opacidad` VARCHAR(10) NULL,
  `angulo_giro` VARCHAR(10) NULL,
  `v_co_ralenti` DECIMAL(12,4) NULL,
  `r_co_ralenti` VARCHAR(10) NULL,
  `v_hc_ralenti` DECIMAL(12,4) NULL,
  `r_hc_ralenti` VARCHAR(10) NULL,
  `v_coco2_ralenti` DECIMAL(12,4) NULL,
  `r_coco2_ralenti` VARCHAR(10) NULL,
  `v_co_2500rpm` DECIMAL(12,4) NULL,
  `r_co_2500rpm` VARCHAR(10) NULL,
  `v_hc_2500rpm` DECIMAL(12,4) NULL,
  `r_hc_2500rpm` VARCHAR(10) NULL,
  `v_coco2_2500rpm` DECIMAL(12,4) NULL,
  `r_coco2_2500rpm` VARCHAR(10) NULL,
  `v_hc_stdr5015` DECIMAL(12,4) NULL,
  `r_hc_stdr5015` VARCHAR(10) NULL,
  `v_co_stdr5015` DECIMAL(12,4) NULL,
  `r_co_stdr5015` VARCHAR(10) NULL,
  `v_no_stdr5015` DECIMAL(12,4) NULL,
  `r_no_stdr5015` VARCHAR(10) NULL,
  `v_hc_stdr2525` DECIMAL(12,4) NULL,
  `r_hc_stdr2525` VARCHAR(10) NULL,
  `v_co_stdr2525` DECIMAL(12,4) NULL,
  `r_co_stdr2525` VARCHAR(10) NULL,
  `v_no_stdr2525` DECIMAL(12,4) NULL,
  `r_no_stdr2525` VARCHAR(10) NULL,
  `r_humo` VARCHAR(10) NULL,
  `v_opa1` DECIMAL(12,4) NULL,
  `v_opa2` DECIMAL(12,4) NULL,
  `v_opa3` DECIMAL(12,4) NULL,
  `v_opa4` DECIMAL(12,4) NULL,
  `v_opa5` DECIMAL(12,4) NULL,
  `v_valida_opa` VARCHAR(10) NULL,
  `r_opa_medida` VARCHAR(10) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `fk_prt_detalle_revision` FOREIGN KEY (`revision_id`)
    REFERENCES `prt_revision` (`id`) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS `prt_diccionario` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `categoria` VARCHAR(30) NOT NULL,
  `codigo` VARCHAR(20) NOT NULL,
  `nombre` VARCHAR(255) NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_dic_cat_cod` (`categoria`, `codigo`)
);

-- Caché global de resoluciones por PPU. El resolver guarda SOLO cuando el
-- consumidor lo pide (save/refresh); nunca como side-effect de una lectura.
CREATE TABLE IF NOT EXISTS `vehiculo_consulta` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `ppu` VARCHAR(12) NOT NULL,
  `patente` VARCHAR(12) NOT NULL,
  `tipo` VARCHAR(100) NULL,
  `marca` VARCHAR(100) NULL,
  `modelo` VARCHAR(100) NULL,
  `anio` INT NULL,
  `color` VARCHAR(50) NULL,
  `numero_motor` VARCHAR(100) NULL,
  `numero_chasis` VARCHAR(100) NULL,
  `combustible` VARCHAR(50) NULL,
  `kilometraje` INT NULL,
  `origen` VARCHAR(20) NOT NULL,
  `resultado_crt` VARCHAR(20) NULL,
  `fec_revision` DATE NULL,
  `fec_vencimiento` DATE NULL,
  `num_certificado` VARCHAR(50) NULL,
  `consultado_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_vehiculo_consulta_ppu` (`ppu`),
  INDEX `idx_vehiculo_consulta_consultado` (`consultado_at`)
);
