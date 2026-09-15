-- Migration 002: consulta_log — metadata por cada consulta al servicio
-- Fecha: 2026-09-14
--
-- Registra IP, fingerprint del API key, endpoint, PPU consultada y timestamp.
-- El API key completo NUNCA se guarda: solo un fingerprint (primeros/ultimos
-- caracteres) para trazabilidad sin exponer credenciales.
--
-- Tabla append-only (DELETE solo por retention/rotacion externa).
CREATE TABLE IF NOT EXISTS `consulta_log` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `ip` VARCHAR(45) NULL COMMENT 'IPv4/IPv6 del caller (x-forwarded-for o socket)',
  `api_key_fingerprint` VARCHAR(16) NULL COMMENT 'Fingerprint del API key (ej. a3f1****9b2c)',
  `endpoint` VARCHAR(50) NULL COMMENT 'Ruta canonica ej. /:ppu/revisiones',
  `ppu` VARCHAR(12) NULL COMMENT 'Patente consultada (si aplica)',
  `consultado_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_consulta_log_consultado` (`consultado_at`),
  INDEX `idx_consulta_log_ppu` (`ppu`),
  INDEX `idx_consulta_log_ip` (`ip`)
);
