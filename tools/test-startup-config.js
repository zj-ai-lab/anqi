import assert from 'node:assert/strict';
import {
  DEFAULT_HOST,
  isLoopbackHost,
  resolveStartupConfig,
  unsafeNoAuthAllowed,
} from '../src/lib/startup-config.js';

assert.equal(isLoopbackHost('127.0.0.1'), true);
assert.equal(isLoopbackHost('127.12.34.56'), true);
assert.equal(isLoopbackHost('::1'), true);
assert.equal(isLoopbackHost('localhost'), false, '开发绕过只接受明确回环 IP');
assert.equal(isLoopbackHost('0.0.0.0'), false);
assert.equal(isLoopbackHost('192.168.1.2'), false);

assert.throws(
  () => resolveStartupConfig({}),
  /未配置登录凭据/,
  '缺省配置必须 fail closed'
);
assert.throws(
  () => resolveStartupConfig({ ANJIAN_USER: 'admin' }),
  /必须同时配置/
);
assert.throws(
  () => resolveStartupConfig({ ANJIAN_PASS_HASH: 'scrypt-v1$test' }),
  /必须同时配置/
);

let config = resolveStartupConfig({
  ANJIAN_USER: 'admin',
  ANJIAN_PASS_HASH: 'scrypt-v1$test',
});
assert.equal(config.host, DEFAULT_HOST);
assert.equal(config.authConfigured, true);
assert.equal(config.unsafeNoAuth, false);

config = resolveStartupConfig({
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  ANJIAN_UNSAFE_NO_AUTH: '1',
});
assert.equal(config.unsafeNoAuth, true);
assert.equal(unsafeNoAuthAllowed({
  NODE_ENV: 'test', HOST: '127.0.0.1', ANJIAN_UNSAFE_NO_AUTH: '1',
}), true);
assert.equal(unsafeNoAuthAllowed({
  NODE_ENV: 'production', HOST: '127.0.0.1', ANJIAN_UNSAFE_NO_AUTH: '1',
}), false);
assert.equal(unsafeNoAuthAllowed({
  NODE_ENV: 'test', HOST: '0.0.0.0', ANJIAN_UNSAFE_NO_AUTH: '1',
}), false);

assert.throws(
  () => resolveStartupConfig({
    NODE_ENV: 'production', HOST: '127.0.0.1', ANJIAN_UNSAFE_NO_AUTH: '1',
  }),
  /production 禁止/
);
assert.throws(
  () => resolveStartupConfig({
    NODE_ENV: 'test', HOST: '0.0.0.0', ANJIAN_UNSAFE_NO_AUTH: '1',
  }),
  /只允许绑定/
);
for (const invalidUnsafeValue of ['true', 'false', '0']) {
  assert.throws(
    () => resolveStartupConfig({
      NODE_ENV: 'test', HOST: '127.0.0.1', ANJIAN_UNSAFE_NO_AUTH: invalidUnsafeValue,
    }),
    /只接受精确值 1/,
    `开发开关值 ${invalidUnsafeValue} 不得被当作关闭或启用`
  );
}
assert.throws(
  () => resolveStartupConfig({
    NODE_ENV: 'Production', ANJIAN_USER: 'admin', ANJIAN_PASS_HASH: 'hash',
  }),
  /必须使用小写/
);
assert.throws(
  () => resolveStartupConfig({
    NODE_ENV: 'production', HOST: '0.0.0.0',
    ANJIAN_USER: 'admin', ANJIAN_PASS_HASH: 'hash',
  }),
  /必须配置 ANJIAN_INTERNAL_KEY/
);

config = resolveStartupConfig({
  NODE_ENV: 'production', HOST: '0.0.0.0',
  ANJIAN_USER: 'admin', ANJIAN_PASS_HASH: 'hash',
  ANJIAN_INTERNAL_KEY: 'separate-key',
});
assert.equal(config.host, '0.0.0.0');
assert.equal(config.unsafeNoAuth, false);

config = resolveStartupConfig({
  NODE_ENV: 'production', HOST: '::1',
  ANJIAN_USER: 'admin', ANJIAN_PASS_HASH: 'hash',
});
assert.equal(config.host, '::1', 'Electron/本机 production 可不启用 internal 面');

// 【红线回归】ANJIAN_SECRET 配置错误此前只在用户第一次保存 key 时才会被
// resolveMasterKey() 校验，比 ANJIAN_USER/ANJIAN_PASS_HASH/ANJIAN_INTERNAL_KEY
// 这几个同样重要的凭据晚了一大截（那几个都在这里、进程启动时就 fail-fast）。
// 现在启动时就应该拒绝。
assert.throws(
  () => resolveStartupConfig({
    NODE_ENV: 'test', ANJIAN_USER: 'admin', ANJIAN_PASS_HASH: 'hash',
    ANJIAN_SECRET: 'too-short',
  }),
  /ANJIAN_SECRET 配置非法.*长度不足/s,
  'ANJIAN_SECRET 太短必须在启动时就拒绝，不能等到第一次保存 key 才暴露'
);
assert.throws(
  () => resolveStartupConfig({
    NODE_ENV: 'test', ANJIAN_USER: 'admin', ANJIAN_PASS_HASH: 'hash',
    ANJIAN_SECRET: 'a'.repeat(40),
  }),
  /ANJIAN_SECRET 配置非法.*熵不足/s,
  'ANJIAN_SECRET 单一字符重复必须在启动时就拒绝'
);
// 不配置 ANJIAN_SECRET（走 secret.key 文件兜底）是完全合法的部署形态，不
// 应该被这条新增校验误伤。
config = resolveStartupConfig({ NODE_ENV: 'test', ANJIAN_USER: 'admin', ANJIAN_PASS_HASH: 'hash' });
assert.equal(config.host, DEFAULT_HOST, '不配置 ANJIAN_SECRET 不应该被误伤');
// 强度足够的 ANJIAN_SECRET 必须放行。
config = resolveStartupConfig({
  NODE_ENV: 'test', ANJIAN_USER: 'admin', ANJIAN_PASS_HASH: 'hash',
  ANJIAN_SECRET: 'Tr0ub4dor&3-correct-horse-battery-staple-2026',
});
assert.equal(config.host, DEFAULT_HOST, '强度足够的 ANJIAN_SECRET 必须放行');

console.log('startup config tests: fail-closed + loopback-only explicit unsafe mode + ANJIAN_SECRET 启动时校验 passed');
