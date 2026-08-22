// SQLite 在线备份（better-sqlite3 backup API；镜像内无 sqlite3 CLI）。
// 部署形态：本文件放数据卷 /app/data/backup.cjs，host cron 每日
//   docker exec anjian node /app/data/backup.cjs
// 按星期几轮转 7 份：/app/data/backup/anjian-1..7.db
//
// secret.key 一并备份（不参与按星期轮转，单份覆盖式同步）：
// settings 表里 agent_api_key_encrypted 这一行只有配上当时加密它的那把主
// 密钥（src/lib/secret-box.js 的 resolveMasterKey()）才能解开。这份脚本此
// 前只备份 anjian.db 本身，secret.key 与它同目录却从不进备份——把备份恢复
// 到一台新机器/新卷上，库里的密文就再也解不开，getStoredApiKey() 会安静
// 地 return null（不抛错、不落审计），用户只会看到"未配置"，看不出真实
// 原因是解密用的 key 文件没跟着备份走。secret.key 一旦生成基本不会再变，
// 不需要像 db 那样按星期轮转——每次运行都覆盖同步一份最新内容即可，保证
// 任意一天的 anjian.db 备份旁边都能找到当时能解开它的那把 key。
// 若部署改用 ANJIAN_SECRET 环境变量（不落地 secret.key 文件）：这份脚本
// 无法替你备份一个环境变量，必须由部署者自行把 ANJIAN_SECRET 存进独立的
// secret 管理系统——见 SELF-HOSTING.md「AI 助理（可选）」一节。
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const src = process.env.DB_PATH || '/app/data/anjian.db';
const dir = '/app/data/backup';
fs.mkdirSync(dir, { recursive: true });
const dow = new Date(Date.now() + 8 * 3600 * 1000).getUTCDay() || 7; // 北京时间星期，日=7
const dest = `${dir}/anjian-${dow}.db`;

const secretKeySrc = path.join(path.dirname(src), 'secret.key');
const secretKeyDest = `${dir}/secret.key.bak`;

const db = new Database(src, { readonly: true });
db.backup(dest)
  .then(() => {
    const size = fs.statSync(dest).size;
    console.log(`[${new Date().toISOString()}] backup ok -> ${dest} (${size} bytes)`);
    if (fs.existsSync(secretKeySrc)) {
      fs.copyFileSync(secretKeySrc, secretKeyDest);
      fs.chmodSync(secretKeyDest, 0o600);
      console.log(`[${new Date().toISOString()}] secret.key backup ok -> ${secretKeyDest}`);
    } else {
      console.log(`[${new Date().toISOString()}] secret.key 不存在（本部署可能改用 ANJIAN_SECRET 环境变量），跳过`);
    }
    process.exit(0);
  })
  .catch((e) => {
    console.error(`[${new Date().toISOString()}] backup FAILED: ${e.message}`);
    process.exit(1);
  });
