-- RF10 (QR de ingreso) y boletas pagadas (RF11 → order.approved).

-- Quién organiza el evento: solo él (o un admin) puede escanear los QR en la entrada.
-- Nulo para las filas creadas antes de esta migración, hasta el siguiente event.updated.
ALTER TABLE event_projection ADD COLUMN organizer_id uuid;

-- Una orden pagada genera exactamente una asistencia (order.approved puede llegar repetido).
CREATE UNIQUE INDEX attendances_order_id_idx ON attendances (order_id) WHERE order_id IS NOT NULL;

-- Pases de un evento: listado para el organizador y check-in.
CREATE INDEX passes_event_id_idx ON passes (event_id);
CREATE INDEX passes_user_id_idx ON passes (user_id);
