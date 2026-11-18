-- Lista de asistentes para el organizador (SCRUM-141). booking-service solo conoce el user_id de
-- cada asistencia: guarda aparte el nombre visible, alimentado por account.registered y
-- profile.updated. Solo el nombre visible; el correo y el resto del perfil no salen de user-service.

CREATE TABLE user_names (
  user_id      uuid PRIMARY KEY,
  display_name text NOT NULL,
  -- Hora del mensaje que lo trajo: uno más viejo que llegue tarde no pisa un nombre más nuevo.
  updated_at   timestamptz NOT NULL
);

-- La lista se pide por evento y se ordena por hora de confirmación.
CREATE INDEX attendances_event_confirmed_idx ON attendances (event_id, confirmed_at) WHERE status = 'confirmed';
