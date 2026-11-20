-- Versión monotónica del conteo de asistentes por evento (festa-infra: attendanceVersion).
-- Sube en 1 con cada cambio de conteo, en la misma transacción que el cambio.
ALTER TABLE event_projection ADD COLUMN attendance_version bigint NOT NULL DEFAULT 0;
