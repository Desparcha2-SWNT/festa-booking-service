// RF10 / RNF7: el QR no se puede falsificar ni reasignar a otro evento.
import { describe, expect, it } from 'vitest';
import { parseQr, qrFor } from '../../src/passes/qr.js';

const PASS = 'f6a7b8c9-d0e1-4f2a-8b3c-4d5e6f7a8b9c';
const EVENT = '6f1c2b8e-3a1d-4c3e-9b0a-1f2e3d4c5b6a';

describe('QR firmado', () => {
  it('un QR generado se lee como válido', () => {
    expect(parseQr(qrFor(PASS, EVENT))).toEqual({ valid: true, passId: PASS, eventId: EVENT });
  });

  it('cambiar el evento invalida la firma', () => {
    const qr = qrFor(PASS, EVENT).replace(EVENT, '7f1c2b8e-3a1d-4c3e-9b0a-1f2e3d4c5b6a');
    expect(parseQr(qr).valid).toBe(false);
  });

  it('una firma inventada no pasa', () => {
    expect(parseQr(`FESTA1.${PASS}.${EVENT}.AAAAAAAAAAAAAAAAAAAAAA`).valid).toBe(false);
  });

  it.each([null, '', 'hola', `OTRO.${PASS}.${EVENT}.x`, 'FESTA1.no-uuid.no-uuid.x'])('rechaza %j', (text) => {
    expect(parseQr(text).valid).toBe(false);
  });
});
