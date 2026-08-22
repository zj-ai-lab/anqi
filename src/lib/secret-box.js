// 静态加密：agent_api_key（用户在设置页填的模型 provider key）落库前用它加密、
// 取出后解密。AES-256-GCM——认证加密，密文被篡改（含 nonce/tag 任一字节被
// 改动）时 decipher.final() 会抛错，不会安静地吐出乱码明文。
//
// 主密钥解析优先级（任务书 §2）：
//   1) env ANJIAN_SECRET——若设置，必须至少有 32 字节 UTF-8 熵（不足直接
//      抛错，不静默降级到弱密钥）；用它的 sha256 摘要当 32 字节 AES key
//      （摘要而不是直接截断/填充，保证无论用户填多长的字符串，最终 key 都
//      是均匀分布的 32 字节，同时保留了"同一个 ANJIAN_SECRET 在所有实例上
//      派生出同一把 key"这个可移植性——多实例共享同一份加密设置时必需）。
//   2) 否则用数据目录下的 secret.key：不存在就首次生成 32 随机字节、写盘时
//      指定 mode 0o600，再显式 chmod 一次（writeFileSync 的 mode 参数会被
//      进程 umask 修正，不能保证最终位恰好是 0o600，必须补一次显式 chmod
//      才能把这件事钉死，不依赖调用环境的 umask 恰好是 022）。
//   3) 数据目录本身：只在缺失时才 mkdir（recursive），已存在的目录不改它的
//      权限——所有权/权限策略是宿主环境（Docker 卷、Electron userData 目录）
//      的责任，本模块不越权覆盖。
//
// 密文格式（自定义，见 encryptSecret/decryptSecret 注释）：
//   "v1:<12字节 nonce 的 base64>:<16字节 GCM tag 的 base64>:<密文 base64>"
// 版本前缀 "v1" 留给将来换算法/换格式时的兼容判断；数据目录与 payload 都不
// 含任何明文 key，本模块的返回值只有"密文字符串"或"解密后的明文字符串"两种
// 形态，调用方（config.js/settings.js）自己负责不把后者写进日志/响应/审计。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 与 src/db.js 的 DB_PATH 默认值同一套推导规则（"data" 目录相对仓库根）——
// 复用同一个 dataDir 概念，不新开一个只有本模块认的环境变量；Electron 侧
// backend-env.js 已经把 DB_PATH 显式指到 config.dataDir/anjian.db，secret.key
// 因此自然落在同一个用户数据目录下，与 anjian.db 相邻。
const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'anjian.db');
const SECRET_KEY_FILENAME = 'secret.key';
const MIN_PASSPHRASE_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const FORMAT_VERSION = 'v1';

function resolveDataDir(env) {
  const dbPath = env.DB_PATH ? String(env.DB_PATH) : DEFAULT_DB_PATH;
  return path.dirname(dbPath);
}

export function secretKeyPath(env = process.env) {
  return path.join(resolveDataDir(env), SECRET_KEY_FILENAME);
}

function deriveKeyFromPassphrase(passphrase) {
  return createHash('sha256').update(passphrase, 'utf8').digest();
}

// 不存在就生成；存在就读出来校验长度（防御性——文件被外部篡改/截断成非
// 32 字节时，明确报错而不是把错误长度的 buffer 直接喂给 createCipheriv
// 抛出一条更难懂的 node:crypto 内部错误）。
function loadOrCreateKeyFile(filePath) {
  if (fs.existsSync(filePath)) {
    const buf = fs.readFileSync(filePath);
    if (buf.length !== KEY_BYTES) {
      throw new Error(`secret.key 长度非法（期望 ${KEY_BYTES} 字节，实际 ${buf.length} 字节）：${filePath}`);
    }
    return buf;
  }
  // 只在目录缺失时才创建；已存在的父目录权限原样不动。
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  fs.writeFileSync(filePath, key, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return key;
}

// 解析主密钥。每次调用都重新解析（不做进程级缓存）：ANJIAN_SECRET 分支只是
// 一次 sha256，file 分支在文件已存在时只是一次同步读盘，两者都足够便宜，
// 没有必要为了省这点开销引入"env 变了但缓存没失效"的陈旧风险。
export function resolveMasterKey(env = process.env) {
  const passphrase = env.ANJIAN_SECRET;
  if (typeof passphrase === 'string' && passphrase.length > 0) {
    if (Buffer.byteLength(passphrase, 'utf8') < MIN_PASSPHRASE_BYTES) {
      throw new Error(`ANJIAN_SECRET 熵不足：至少需要 ${MIN_PASSPHRASE_BYTES} 字节，建议用随机生成的长字符串（例如 openssl rand -base64 32）`);
    }
    return deriveKeyFromPassphrase(passphrase);
  }
  return loadOrCreateKeyFile(secretKeyPath(env));
}

export function encryptSecret(plaintext, key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`加密主密钥非法：必须是 ${KEY_BYTES} 字节 Buffer`);
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext ?? ''), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_VERSION, nonce.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

// 安全失败：格式非法（分段数不对、版本前缀不对、base64 解不出来、nonce/tag
// 长度不对）与"密钥错误/密文被篡改"（GCM 校验失败）统一抛错，调用方只需要
// try/catch 就能拿到"这条密文当前解不开"的结论，不需要分辨具体是哪一种——
// 两者都不应该被当作"能拿到明文"处理。
export function decryptSecret(payload, key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`解密主密钥非法：必须是 ${KEY_BYTES} 字节 Buffer`);
  }
  const parts = String(payload ?? '').split(':');
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error('密文格式非法：分段数或版本前缀不符');
  }
  const [, nonceB64, tagB64, ciphertextB64] = parts;
  let nonce;
  let tag;
  let ciphertext;
  try {
    nonce = Buffer.from(nonceB64, 'base64');
    tag = Buffer.from(tagB64, 'base64');
    ciphertext = Buffer.from(ciphertextB64, 'base64');
  } catch {
    throw new Error('密文格式非法：base64 解码失败');
  }
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('密文格式非法：nonce/tag 长度不符');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  // GCM 校验失败（密钥错误或密文被篡改）在这里抛出——不吞掉，调用方必须
  // try/catch。
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// 掩码展示：只留末 4 位，其余折叠成省略号。用于 GET /api/settings 等只读
// 展示面——绝不允许把明文/近似明文回显给前端。长度不足 4 位时整串折叠，
// 不泄露任何真实字符。
export function maskSecret(value) {
  const str = String(value ?? '');
  if (str.length <= 4) return '*'.repeat(str.length || 1);
  return `…${str.slice(-4)}`;
}
