import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.js';

// RF10 / RNF7: el QR lleva el id del pase y del evento, firmados con HMAC-SHA256. Sin el secreto
// nadie puede fabricar un QR válido; el "un solo uso" lo garantiza la BD (passes.used_at).
// Formato: FESTA1.<passId>.<eventId>.<firma base64url de 22 caracteres>
const PREFIX = 'FESTA1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let secret;
function getSecret() {
  secret ??= fs.readFileSync(config.qrSigningSecretPath, 'utf8').trim();
  if (!secret) throw new Error('QR_SIGNING_SECRET_PATH está vacío');
  return secret;
}

function sign(passId, eventId) {
  return crypto.createHmac('sha256', getSecret()).update(`${PREFIX}.${passId}.${eventId}`).digest('base64url').slice(0, 22);
}

export function qrFor(passId, eventId) {
  return `${PREFIX}.${passId}.${eventId}.${sign(passId, eventId)}`;
}

/**
 * Lee un QR. Devuelve { valid, passId?, eventId? }. Si el formato es reconocible pero la firma no
 * coincide, devuelve los ids (para registrar el intento rechazado) con valid=false.
 */
export function parseQr(text) {
  if (typeof text !== 'string') return { valid: false };
  const parts = text.trim().split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) return { valid: false };
  const [, passId, eventId, signature] = parts;
  if (!UUID.test(passId) || !UUID.test(eventId)) return { valid: false };
  const expected = Buffer.from(sign(passId, eventId));
  const given = Buffer.from(signature);
  const valid = expected.length === given.length && crypto.timingSafeEqual(expected, given);
  return { valid, passId, eventId };
}
