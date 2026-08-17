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

console.log('startup config tests: fail-closed + loopback-only explicit unsafe mode passed');
