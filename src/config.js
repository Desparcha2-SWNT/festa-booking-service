import path from 'node:path';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

// Valor de `trust proxy` de Express. Un número es la cantidad de proxies delante del servicio;
// también acepta true/false o una lista de subredes, como Express.
export function parseTrustProxy(value) {
  if (value === undefined || value === '') return 1;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8084),
  // Las peticiones llegan a través de Kong, que agrega la IP del cliente en X-Forwarded-For.
  // Por defecto 1: en el compose está Kong; en AWS, Kong reenvía por un NLB TCP que no toca
  // los encabezados.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  databaseUrl: required('DATABASE_URL'),
  amqpUrl: required('AMQP_URL'),
  jwtIssuer: required('JWT_ISSUER'),
  jwtPublicKeyPath: required('JWT_PUBLIC_KEY_PATH'),
  // En la imagen de Docker el Dockerfile copia los contratos a ./contracts y fija esta
  // variable; en local, por defecto asume festa-infra clonado como hermano de este repo.
  // RF10/RNF7: secreto HMAC con el que se firma el contenido de cada QR (festa-infra/scripts/gen-secrets.sh).
  qrSigningSecretPath: required('QR_SIGNING_SECRET_PATH'),
  // El ingreso se habilita estos minutos antes del inicio y cierra cuando termina el evento.
  checkInOpensMinutesBefore: Number(process.env.CHECKIN_OPENS_MINUTES_BEFORE ?? 120),
  contractsDir: process.env.FESTA_CONTRACTS_DIR ?? path.resolve('../festa-infra/contracts'),
};
