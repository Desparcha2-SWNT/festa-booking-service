# festa-booking-service

RF7, RF10: asistencia y QR único de un solo uso. Node/Express con PostgreSQL (`booking_db`).

## API de asistencia

Todas piden JWT. El cliente las llama con el prefijo `/api`, que Kong quita.

| Método y ruta | Qué hace | Respuestas |
|---|---|---|
| `POST /bookings/events/{id}/attendance` | Confirma la asistencia a un evento gratis y crea su pase | 201, 200 si ya estaba confirmada, 404, 409 (`closed`, `requires_ticket`, `full`) |
| `DELETE /bookings/events/{id}/attendance` | Cancela la asistencia y libera el cupo | 200, 404, 409 si el pase ya se usó o el evento terminó |
| `GET /bookings/events/{id}/attendance` | Devuelve cupo, conteo y si el usuario va | 200, 404 |

El cupo se valida con una copia local del evento, alimentada por `event.published` y `event.updated`.

## Correr en local

```bash
cp .env.example .env   # y ajusta los valores
npm ci
npm test
npm start              # usa el puerto 8084
```

Dentro de `festa-infra` se levanta con `docker compose --profile booking up`.
