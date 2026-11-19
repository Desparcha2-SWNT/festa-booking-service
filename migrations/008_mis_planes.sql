-- SCRUM-142, «Mis planes»: la tarjeta de cada plan muestra el lugar y la portada del evento. Los dos vienen
-- en el snapshot de event.published y event.updated, que este servicio ya consume. Son nulos para los
-- eventos que se proyectaron antes de esta migración, hasta que llegue su siguiente snapshot.
ALTER TABLE event_projection ADD COLUMN venue_name text;
ALTER TABLE event_projection ADD COLUMN cover_image_url text;
