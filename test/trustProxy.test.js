import { describe, expect, it } from 'vitest';
import { parseTrustProxy } from '../src/config.js';

describe('parseTrustProxy', () => {
  it.each([
    [undefined, 1],
    ['', 1],
    ['0', 0],
    ['2', 2],
    ['true', true],
    ['false', false],
    ['10.0.0.0/8', '10.0.0.0/8'],
  ])('%j se interpreta como %j', (value, expected) => {
    expect(parseTrustProxy(value)).toBe(expected);
  });
});
