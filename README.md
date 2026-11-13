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

## Pases y QR (RF10, RNF7)

| Método y ruta | Qué hace | Respuestas |
|---|---|---|
| `GET /bookings/passes/mine` | «Mis entradas»: pases del usuario con su QR (solo los vigentes llevan QR) | 200 |
| `GET /bookings/passes/{id}` | Un pase propio | 200, 404 |
| `POST /bookings/passes/check-in` `{qr, eventId}` | El organizador (o un admin) escanea el QR en la entrada | 200 `{valid: true, ...}`, 403 `not_organizer`, 409 `already_used` / `invalid_signature` / `wrong_event` / `revoked` / `outside_window` |
| `GET /bookings/events/{id}/check-ins` | Organizador: pases vigentes e ingresos | 200, 403, 404 |

- El QR es `FESTA1.<passId>.<eventId>.<firma>`, con firma HMAC-SHA256 (`QR_SIGNING_SECRET_PATH`): no se puede fabricar
  ni pasar a otro evento.
- **Un solo uso:** `UPDATE passes SET used_at = now() WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`. Varias
  lecturas simultáneas del mismo QR: solo una entra (hay prueba de integración).
- El ingreso abre `CHECKIN_OPENS_MINUTES_BEFORE` (120) minutos antes del inicio y cierra al terminar el evento.
- Cada lectura publica `pass.checked_in` o `pass.check_in_rejected` con el motivo (detección de fraude en analytics).

## Boletas pagadas (RF11)

- `order.approved` (payment-service) crea una asistencia `ticket` con **un pase por boleta** y publica
  `attendance.confirmed{source: ticket, orderId}`. Es idempotente por `orderId`.
- `order.refunded` revoca la asistencia y sus pases (`attendance.cancelled{reason: refunded}`).

## Correr en local

```bash
cp .env.example .env   # y ajusta los valores
npm ci
npm test               # unitarias
TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/booking_it npm test   # + integración con Postgres
npm start              # usa el puerto 8084
```

Dentro de `festa-infra` se levanta con `docker compose --profile booking up`.
