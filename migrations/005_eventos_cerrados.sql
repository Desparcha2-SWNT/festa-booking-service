-- Lápida de eventos cerrados (cancelados o expirados). Los mensajes llegan desordenados: un event.updated
-- retrasado no debe volver a publicar un evento que ya terminó o se canceló. event.expired no lleva
-- versión, así que no sirve la comparación por `version`; esta tabla es la que manda.

CREATE TABLE closed_events (
  event_id  uuid PRIMARY KEY,
  status    text NOT NULL CHECK (status IN ('cancelled', 'expired')),
  closed_at timestamptz NOT NULL DEFAULT now()
);
