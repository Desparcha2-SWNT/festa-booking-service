-- Lista de asistentes para el organizador (SCRUM-141). booking-service solo conoce el user_id de
-- cada asistencia: guarda aparte el nombre visible, alimentado por account.display_name_set, que trae
-- solo id y nombre. El correo, el rol y el resto del perfil no llegan a este servicio.

CREATE TABLE user_names (
  user_id      uuid PRIMARY KEY,
  display_name text NOT NULL,
  -- Hora del mensaje que lo trajo: uno más viejo que llegue tarde no pisa un nombre más nuevo.
  updated_at   timestamptz NOT NULL
);

-- Lápida de cuentas borradas (Ley 1581). account.deleted borra el nombre; si después llega tarde un
-- account.display_name_set anterior al borrado, esta tabla impide que el nombre vuelva a guardarse.
-- Solo guarda el id (un uuid sin datos personales) y la hora del borrado.
CREATE TABLE deleted_users (
  user_id    uuid PRIMARY KEY,
  deleted_at timestamptz NOT NULL
);

-- La lista se pide por evento y se ordena por hora de confirmación.
CREATE INDEX attendances_event_confirmed_idx ON attendances (event_id, confirmed_at) WHERE status = 'confirmed';
