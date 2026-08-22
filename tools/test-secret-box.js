// src/lib/secret-box.js 的最小自检：AES-256-GCM 往返、错误密钥解不开、
// 密文格式非法时安全失败（抛错而不是吐出乱码明文）、secret.key 首次生成
// 的权限位必须是 0o600、ANJIAN_SECRET 熵不足必须拒绝。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  resolveMasterKey,
  secretKeyPath,
  encryptSecret,
  decryptSecret,
  maskSecret,
} = await import('../src/lib/secret-box.js');

// ---- 1) 往返：同一把 key 加密再解密，必须原样拿回明文 ----
{
  const key = Buffer.from('0'.repeat(64), 'hex'); // 32 字节全零，纯粹用来测算法本身
  const plaintext = 'sk-test-1234567890abcdef';
  const ciphertext = encryptSecret(plaintext, key);
  assert.equal(typeof ciphertext, 'string');
  assert.match(ciphertext, /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert.equal(decryptSecret(ciphertext, key), plaintext);
  console.log('  [1/6] 往返：ok');
}

// ---- 2) 错误密钥解不开：GCM 认证失败必须抛错，不能吐出乱码明文 ----
{
  const key = Buffer.alloc(32, 1);
  const wrongKey = Buffer.alloc(32, 2);
  const ciphertext = encryptSecret('secret-value', key);
  assert.throws(() => decryptSecret(ciphertext, wrongKey), 'wrongKey 必须解不开');
  console.log('  [2/6] 错误密钥解不开：ok');
}

// ---- 3) 密文格式非法：分段数不对 / 版本前缀不对 / base64 解不出来，都必须
//      安全失败（抛错），不能让某个畸形输入意外走通 ----
{
  const key = Buffer.alloc(32, 3);
  for (const bad of ['', 'not-even-colons', 'v2:aa:bb:cc', 'v1:aa:bb', 'v1:not-base64!!!:bb:cc', 'v1:::']) {
    assert.throws(() => decryptSecret(bad, key), `畸形密文应该抛错: ${JSON.stringify(bad)}`);
  }
  console.log('  [3/6] 畸形密文安全失败：ok');
}

// ---- 4) 每次加密用不同 nonce：同一明文两次加密，密文必须不同（防止 nonce
//      复用泄露信息） ----
{
  const key = Buffer.alloc(32, 4);
  const a = encryptSecret('same-plaintext', key);
  const b = encryptSecret('same-plaintext', key);
  assert.notEqual(a, b, '同一明文两次加密的密文不应该相同（nonce 必须随机）');
  assert.equal(decryptSecret(a, key), 'same-plaintext');
  assert.equal(decryptSecret(b, key), 'same-plaintext');
  console.log('  [4/6] nonce 随机性：ok');
}

// ---- 5) secret.key 首次生成：权限位必须是 0o600，且往返可用；第二次调用
//      resolveMasterKey() 必须读到同一把 key（不是每次重新生成） ----
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-secret-box-'));
  const env = { DB_PATH: path.join(scratch, 'sub', 'anjian.db') }; // 目录本身也不存在，顺带验证 mkdirSync(recursive)
  const keyPath = secretKeyPath(env);
  assert.equal(fs.existsSync(keyPath), false, '首次调用前 secret.key 不应该已经存在');

  const key1 = resolveMasterKey(env);
  assert.equal(fs.existsSync(keyPath), true, 'resolveMasterKey() 必须在缺失时自动生成 secret.key');
  const mode = fs.statSync(keyPath).mode & 0o777;
  assert.equal(mode, 0o600, `secret.key 权限位必须是 0o600，实际 ${mode.toString(8)}`);

  const key2 = resolveMasterKey(env);
  assert.ok(key1.equals(key2), '第二次 resolveMasterKey() 必须读到同一把已生成的 key，不是重新生成');

  const ciphertext = encryptSecret('round-trip-via-file-key', key1);
  assert.equal(decryptSecret(ciphertext, key2), 'round-trip-via-file-key');

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log('  [5/6] secret.key 首次生成权限位 0o600 + 幂等复用：ok');
}

// ---- 6) ANJIAN_SECRET：熵不足必须拒绝；熵足够时优先于 secret.key 生效，
//      且同一 passphrase 必须每次派生出同一把 key（可移植性——多实例共享
//      同一份 ANJIAN_SECRET 时，各自派生的 key 必须一致） ----
{
  assert.throws(
    () => resolveMasterKey({ ANJIAN_SECRET: 'too-short' }),
    /熵不足/,
    'ANJIAN_SECRET 短于 32 字节必须拒绝'
  );
  const longSecret = 'a'.repeat(40);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-secret-box-env-'));
  const env = { DB_PATH: path.join(scratch, 'anjian.db'), ANJIAN_SECRET: longSecret };
  const keyFromEnv1 = resolveMasterKey(env);
  const keyFromEnv2 = resolveMasterKey(env);
  assert.ok(keyFromEnv1.equals(keyFromEnv2), '同一个 ANJIAN_SECRET 必须每次派生出同一把 key');
  assert.equal(fs.existsSync(secretKeyPath(env)), false, 'ANJIAN_SECRET 存在时不应该落地 secret.key');

  // 掩码：只留末 4 位，短字符串整串折叠，不泄露任何真实字符。
  assert.equal(maskSecret('sk-abcdefgh1234'), '…1234');
  assert.equal(maskSecret('ab'), '**');
  assert.equal(maskSecret(''), '*');

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log('  [6/6] ANJIAN_SECRET 熵校验 + 派生确定性 + 掩码：ok');
}

console.log('secret-box 自检全部通过');
