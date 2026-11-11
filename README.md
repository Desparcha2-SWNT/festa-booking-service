# festa-booking-service

RF7, RF10: asistencia y QR único de un solo uso. Node/Express con PostgreSQL (`booking_db`).

Por ahora es el esqueleto: arranca, aplica las migraciones y responde `GET /health`. La API de
asistencia (SCRUM-71) y el consumo de eventos llegan en los siguientes PR.

## Correr en local

```bash
cp .env.example .env   # y ajusta los valores
npm ci
npm test
npm start              # usa el puerto 8084
```

Dentro de `festa-infra` se levanta con `docker compose --profile booking up`.
