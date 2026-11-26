-- La hora de una confirmación es la de cuando se registra, no la del inicio de la transacción.
-- now() devuelve la hora del BEGIN. Si dos confirmaciones compiten, la que empezó primero puede tomar
-- el candado del evento de segunda y quedar con una hora anterior a la otra, aunque su conteo sea más
-- nuevo. event-service ordena los conteos por esta hora (confirmedAt / cancelledAt) y descartaría el
-- correcto. clock_timestamp() es la hora real del INSERT, que ocurre después de tomar el candado.
ALTER TABLE attendances ALTER COLUMN confirmed_at SET DEFAULT clock_timestamp();
