-- Asistencia (RF7, SCRUM-71). booking-service no le pregunta el cupo a event-service: mantiene
-- su propia copia de lo que necesita, alimentada por event.published, event.updated y demás
-- (ver festa-infra/contracts/README.md § Asistencia gratis).

CREATE TABLE event_projection (
  event_id       uuid PRIMARY KEY,
  title          text NOT NULL,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  capacity       integer,
  ticketed       boolean NOT NULL,
  status         text NOT NULL CHECK (status IN ('published', 'hidden', 'cancelled', 'expired')),
  -- Los mensajes pueden llegar desordenados: se ignora un snapshot con version <= la guardada.
  version        integer NOT NULL,
  -- No viene del snapshot: lo lleva este servicio, en la misma transacción que la asistencia.
  attendee_count integer NOT NULL DEFAULT 0 CHECK (attendee_count >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attendances (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES event_projection (event_id),
  user_id       uuid NOT NULL,
  source        text NOT NULL CHECK (source IN ('rsvp', 'ticket')),
  order_id      uuid,
  status        text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  confirmed_at  timestamptz NOT NULL DEFAULT now(),
  cancelled_at  timestamptz
);

-- Última barrera contra duplicados: un usuario tiene como máximo un RSVP activo por evento.
CREATE UNIQUE INDEX attendances_one_active_rsvp_idx
  ON attendances (event_id, user_id) WHERE status = 'confirmed' AND source = 'rsvp';
CREATE INDEX attendances_user_id_idx ON attendances (user_id);

-- Un pase por asistente. El QR firmado se genera a partir del id del pase (SCRUM-89).
CREATE TABLE passes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_id uuid NOT NULL REFERENCES attendances (id) ON DELETE CASCADE,
  event_id      uuid NOT NULL,
  user_id       uuid NOT NULL,
  used_at       timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX passes_attendance_id_idx ON passes (attendance_id);
