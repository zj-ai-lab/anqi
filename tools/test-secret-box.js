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
  console.log('  [1/7] 往返：ok');
}

// ---- 2) 错误密钥解不开：GCM 认证失败必须抛错，不能吐出乱码明文 ----
{
  const key = Buffer.alloc(32, 1);
  const wrongKey = Buffer.alloc(32, 2);
  const ciphertext = encryptSecret('secret-value', key);
  assert.throws(() => decryptSecret(ciphertext, wrongKey), 'wrongKey 必须解不开');
  console.log('  [2/7] 错误密钥解不开：ok');
}

// ---- 3) 密文格式非法：分段数不对 / 版本前缀不对 / base64 解不出来，都必须
//      安全失败（抛错），不能让某个畸形输入意外走通 ----
{
  const key = Buffer.alloc(32, 3);
  for (const bad of ['', 'not-even-colons', 'v2:aa:bb:cc', 'v1:aa:bb', 'v1:not-base64!!!:bb:cc', 'v1:::']) {
    assert.throws(() => decryptSecret(bad, key), `畸形密文应该抛错: ${JSON.stringify(bad)}`);
  }
  console.log('  [3/7] 畸形密文安全失败：ok');
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
  console.log('  [4/7] nonce 随机性：ok');
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
  console.log('  [5/7] secret.key 首次生成权限位 0o600 + 幂等复用：ok');
}

// ---- 5.5) 【红线回归】secret.key 首次生成的 TOCTOU 竞态：多个进程并发触发
//      首次生成时，必须只有一份 key 真正落地，不能出现"后写者用自己生成的
//      随机字节覆盖先写者"——覆盖之后，用先写者那把 key 加密过的历史数据
//      会安静地解不开（GCM 校验失败，getStoredApiKey() 返回 null，不抛错、
//      不落审计）。真实 TOCTOU 需要跨进程并发才能复现（同一事件循环里的
//      同步代码不存在竞态窗口），这里真的并发起若干个独立 Node 子进程去抢
//      同一个 secret.key 的首次生成。 ----
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-secret-box-race-'));
  const dbPath = path.join(scratch, 'anjian.db');
  const keyPath = secretKeyPath({ DB_PATH: dbPath });
  assert.equal(fs.existsSync(keyPath), false, '并发测试前 secret.key 不应该已经存在');

  const { execFile } = await import('node:child_process');
  const { fileURLToPath: toPath, pathToFileURL } = await import('node:url');
  const secretBoxURL = pathToFileURL(path.join(path.dirname(toPath(import.meta.url)), '..', 'src', 'lib', 'secret-box.js')).href;
  const script = `
    import(${JSON.stringify(secretBoxURL)}).then(({ resolveMasterKey }) => {
      process.stdout.write(resolveMasterKey({ DB_PATH: ${JSON.stringify(dbPath)} }).toString('hex'));
    });
  `;
  const CONCURRENCY = 6;
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => new Promise((resolve, reject) => {
      execFile(process.execPath, ['--input-type=module', '-e', script], (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
    }))
  );
  const distinctKeys = new Set(results);
  assert.equal(distinctKeys.size, 1, `${CONCURRENCY} 个并发首次生成的进程必须只产生 1 把 key，实际产生了 ${distinctKeys.size} 把`);

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log('  [5.5/7] secret.key 首次生成并发安全（写临时文件+linkSync 原子提交，不被后写者覆盖）：ok');
}

// ---- 6) ANJIAN_SECRET：长度不足/字符多样性不足必须分别拒绝；两项都满足
//      时优先于 secret.key 生效，且同一 passphrase 必须每次派生出同一把
//      key（可移植性——多实例共享同一份 ANJIAN_SECRET 时，各自派生的 key
//      必须一致） ----
{
  assert.throws(
    () => resolveMasterKey({ ANJIAN_SECRET: 'too-short' }),
    /长度不足/,
    'ANJIAN_SECRET 短于 32 字节必须拒绝'
  );
  // 【红线回归】纯长度校验挡不住"看起来长、实际是单一字符重复"的输入——
  // 探针实测过 32 个空格与 'a'.repeat(32) 都能通过纯长度校验；现在字符多样
  // 性不足必须单独拒绝，错误信息用"熵不足"（与长度不足的措辞区分开，指向
  // 不同的失败原因）。
  for (const weak of ['a'.repeat(40), ' '.repeat(32), '0'.repeat(64)]) {
    assert.throws(
      () => resolveMasterKey({ ANJIAN_SECRET: weak }),
      /熵不足/,
      `ANJIAN_SECRET=${JSON.stringify(weak)}（单一字符重复）必须被拒绝`
    );
  }

  const longSecret = 'Tr0ub4dor&3-correct-horse-battery-staple-2026';
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-secret-box-env-'));
  const env = { DB_PATH: path.join(scratch, 'anjian.db'), ANJIAN_SECRET: longSecret };
  const keyFromEnv1 = resolveMasterKey(env);
  const keyFromEnv2 = resolveMasterKey(env);
  assert.ok(keyFromEnv1.equals(keyFromEnv2), '同一个 ANJIAN_SECRET 必须每次派生出同一把 key（含 scrypt 缓存命中的第二次调用）');
  assert.equal(fs.existsSync(secretKeyPath(env)), false, 'ANJIAN_SECRET 存在时不应该落地 secret.key');

  // 不同的 ANJIAN_SECRET 必须派生出不同的 key（scrypt 缓存按 passphrase 精
  // 确值区分，不会把两个不同口令混算成同一把 key）。
  const otherEnv = { DB_PATH: path.join(scratch, 'anjian2.db'), ANJIAN_SECRET: 'Another-Str0ng-Passphrase-Xyz-9876!' };
  const keyFromOtherSecret = resolveMasterKey(otherEnv);
  assert.ok(!keyFromEnv1.equals(keyFromOtherSecret), '不同的 ANJIAN_SECRET 必须派生出不同的 key');

  // 掩码：只留末 4 位，短字符串整串折叠，不泄露任何真实字符。
  assert.equal(maskSecret('sk-abcdefgh1234'), '…1234');
  assert.equal(maskSecret('ab'), '**');
  assert.equal(maskSecret(''), '*');

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log('  [6/7] ANJIAN_SECRET 长度/熵校验 + scrypt 派生确定性与区分度 + 掩码：ok');
}

console.log('secret-box 自检全部通过');
