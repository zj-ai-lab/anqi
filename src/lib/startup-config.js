import net from 'node:net';
import { assertPassphraseStrength } from './secret-box.js';

export const DEFAULT_HOST = '127.0.0.1';

function configured(value) {
  return typeof value === 'string' && value.length > 0;
}

export function isLoopbackHost(value) {
  const host = String(value || '').trim();
  if (host === '::1') return true;
  return net.isIP(host) === 4 && host.split('.')[0] === '127';
}

export function unsafeNoAuthAllowed(env = process.env) {
  const host = String(env.HOST || DEFAULT_HOST).trim();
  const nodeEnv = String(env.NODE_ENV || 'development');
  return env.ANJIAN_UNSAFE_NO_AUTH === '1'
    && nodeEnv.toLowerCase() !== 'production'
    && isLoopbackHost(host);
}

export function resolveStartupConfig(env = process.env) {
  const host = String(env.HOST || DEFAULT_HOST).trim();
  const nodeEnv = String(env.NODE_ENV || 'development');
  const unsafeRaw = env.ANJIAN_UNSAFE_NO_AUTH;

  if (nodeEnv.toLowerCase() === 'production' && nodeEnv !== 'production') {
    throw new Error('NODE_ENV=production 必须使用小写，避免安全策略解释不一致');
  }
  if (unsafeRaw !== undefined && unsafeRaw !== '' && unsafeRaw !== '1') {
    throw new Error('ANJIAN_UNSAFE_NO_AUTH 只接受精确值 1；不需要时请删除该变量');
  }

  const unsafeNoAuth = unsafeRaw === '1';
  if (unsafeNoAuth && nodeEnv.toLowerCase() === 'production') {
    throw new Error('production 禁止 ANJIAN_UNSAFE_NO_AUTH=1');
  }
  if (unsafeNoAuth && !isLoopbackHost(host)) {
    throw new Error('ANJIAN_UNSAFE_NO_AUTH=1 只允许绑定 127.0.0.0/8 或 ::1');
  }

  const hasUser = configured(env.ANJIAN_USER);
  const hasHash = configured(env.ANJIAN_PASS_HASH);
  if (!unsafeNoAuth && hasUser !== hasHash) {
    throw new Error('ANJIAN_USER 与 ANJIAN_PASS_HASH 必须同时配置');
  }
  if (!unsafeNoAuth && !hasUser) {
    throw new Error('未配置登录凭据；本机开发如需无鉴权，须显式设置 ANJIAN_UNSAFE_NO_AUTH=1');
  }
  if (!unsafeNoAuth && !isLoopbackHost(host) && !configured(env.ANJIAN_INTERNAL_KEY)) {
    throw new Error('非回环监听必须配置 ANJIAN_INTERNAL_KEY');
  }

  // ANJIAN_SECRET（AI 助理「界面填 key」的加密主密钥来源之一）此前只在用户
  // 第一次保存 key 时才会被 src/lib/secret-box.js 的 resolveMasterKey() 校
  // 验——配置写短了/写弱了，要等到那一刻才以一个 500 的形式暴露出来，比
  // ANJIAN_USER/ANJIAN_PASS_HASH/ANJIAN_INTERNAL_KEY 这几个同样重要的凭据
  // 晚了一大截（它们都在这里、进程启动时就 fail-fast）。这里只在配置了该
  // 变量时才校验——不配置时走 secret.key 文件兜底，是完全合法的部署形态，
  // 不应该被这条检查拦下。
  if (configured(env.ANJIAN_SECRET)) {
    try {
      assertPassphraseStrength(env.ANJIAN_SECRET);
    } catch (error) {
      throw new Error(`ANJIAN_SECRET 配置非法：${error.message}`);
    }
  }

  return Object.freeze({
    host,
    nodeEnv,
    unsafeNoAuth,
    authConfigured: hasUser && hasHash,
  });
}
