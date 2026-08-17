import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import passwordHash from '../src/lib/password-hash.cjs';

const current = passwordHash.hashPassword('correct horse battery staple', {});
assert.match(current, /^scrypt-v1\$16384\$8\$1\$32\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
assert.equal(passwordHash.verifyPassword('correct horse battery staple', current), true);
assert.equal(passwordHash.verifyPassword('wrong password', current), false);
assert.equal(passwordHash.parsePasswordHash(current).N, 16384);

const raised = passwordHash.hashPassword('raised-cost', { ANJIAN_SCRYPT_N: '32768' });
assert.match(raised, /^scrypt-v1\$32768\$8\$1\$32\$/);
assert.equal(passwordHash.verifyPassword('raised-cost', raised), true);
assert.throws(
  () => passwordHash.hashPassword('bad-cost', { ANJIAN_SCRYPT_N: '12345' }),
  /ANJIAN_SCRYPT_N/
);

const legacySalt = crypto.randomBytes(12).toString('hex');
const legacy = legacySalt + ':' + crypto.scryptSync('legacy-password', legacySalt, 32).toString('hex');
assert.deepEqual(passwordHash.verifyPasswordDetailed('legacy-password', legacy), { ok: true, legacy: true });
assert.deepEqual(passwordHash.verifyPasswordDetailed('wrong', legacy), { ok: false, legacy: true });

for (const malformed of [
  '',
  'scrypt-v1$16384$8$1$32$00$00',
  'scrypt-v1$999999999$8$1$32$00112233445566778899aabbccddeeff$' + '00'.repeat(32),
  'scrypt-v1$16384$9$1$32$00112233445566778899aabbccddeeff$' + '00'.repeat(32),
  'not-a-salt:not-a-hash',
]) {
  assert.equal(passwordHash.verifyPassword('anything', malformed), false);
}

console.log('password hash tests: versioned format + legacy compatibility passed');
