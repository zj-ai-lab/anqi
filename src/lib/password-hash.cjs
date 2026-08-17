'use strict';

const crypto = require('node:crypto');

const VERSION = 'scrypt-v1';
const DEFAULT_N = 16384;
const R = 8;
const P = 1;
const DK_LEN = 32;
const SALT_LEN = 16;
const MIN_N = 16384;
const MAX_N = 262144;

function validHex(value, bytes) {
  return typeof value === 'string'
    && value.length === bytes * 2
    && /^[0-9a-f]+$/i.test(value);
}

function validN(value) {
  return Number.isSafeInteger(value)
    && value >= MIN_N
    && value <= MAX_N
    && (value & (value - 1)) === 0;
}

function scryptMaxmem(N, r, p) {
  const required = 128 * N * r + 128 * r * p;
  return Math.max(32 * 1024 * 1024, required + 1024 * 1024);
}

function generationN(env = process.env) {
  const raw = env.ANJIAN_SCRYPT_N;
  if (raw === undefined || raw === '') return DEFAULT_N;
  const N = Number(raw);
  if (!validN(N)) {
    throw new Error(`ANJIAN_SCRYPT_N 必须是 ${MIN_N}–${MAX_N} 之间的 2 的幂`);
  }
  return N;
}

function parseVersioned(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 7 || parts[0] !== VERSION) return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const dkLen = Number(parts[4]);
  const saltHex = parts[5];
  const hashHex = parts[6];
  if (!validN(N) || r !== R || p !== P || dkLen !== DK_LEN) return null;
  if (!validHex(saltHex, SALT_LEN) || !validHex(hashHex, dkLen)) return null;
  return { kind: VERSION, N, r, p, dkLen, saltHex, hashHex };
}

function parseLegacy(stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 2 || !parts[0] || !validHex(parts[1], DK_LEN)) return null;
  return { kind: 'legacy', salt: parts[0], hashHex: parts[1] };
}

function parsePasswordHash(stored) {
  return parseVersioned(stored) || parseLegacy(stored);
}

function verifyPasswordDetailed(password, stored) {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return { ok: false, legacy: false };
  try {
    let calculated;
    if (parsed.kind === 'legacy') {
      // 旧格式把盐的十六进制文本本身交给 scrypt；必须原样保留才能验旧凭据。
      calculated = crypto.scryptSync(String(password), parsed.salt, DK_LEN, {
        N: DEFAULT_N, r: R, p: P, maxmem: scryptMaxmem(DEFAULT_N, R, P),
      });
    } else {
      calculated = crypto.scryptSync(String(password), Buffer.from(parsed.saltHex, 'hex'), parsed.dkLen, {
        N: parsed.N, r: parsed.r, p: parsed.p, maxmem: scryptMaxmem(parsed.N, parsed.r, parsed.p),
      });
    }
    const expected = Buffer.from(parsed.hashHex, 'hex');
    return {
      ok: expected.length === calculated.length && crypto.timingSafeEqual(calculated, expected),
      legacy: parsed.kind === 'legacy',
    };
  } catch {
    return { ok: false, legacy: parsed.kind === 'legacy' };
  }
}

function verifyPassword(password, stored) {
  return verifyPasswordDetailed(password, stored).ok;
}

function hashPassword(password, env = process.env) {
  const N = generationN(env);
  const salt = crypto.randomBytes(SALT_LEN);
  const hash = crypto.scryptSync(String(password), salt, DK_LEN, {
    N, r: R, p: P, maxmem: scryptMaxmem(N, R, P),
  });
  return [VERSION, N, R, P, DK_LEN, salt.toString('hex'), hash.toString('hex')].join('$');
}

module.exports = {
  DEFAULT_N,
  VERSION,
  generationN,
  hashPassword,
  parsePasswordHash,
  verifyPassword,
  verifyPasswordDetailed,
};
