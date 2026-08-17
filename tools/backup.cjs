// SQLite 在线备份（better-sqlite3 backup API；镜像内无 sqlite3 CLI）。
// 部署形态：本文件放数据卷 /app/data/backup.cjs，host cron 每日
//   docker exec anjian node /app/data/backup.cjs
// 按星期几轮转 7 份：/app/data/backup/anjian-1..7.db
const Database = require('better-sqlite3');
const fs = require('node:fs');

const src = process.env.DB_PATH || '/app/data/anjian.db';
const dir = '/app/data/backup';
fs.mkdirSync(dir, { recursive: true });
const dow = new Date(Date.now() + 8 * 3600 * 1000).getUTCDay() || 7; // 北京时间星期，日=7
const dest = `${dir}/anjian-${dow}.db`;

const db = new Database(src, { readonly: true });
db.backup(dest)
  .then(() => {
    const size = fs.statSync(dest).size;
    console.log(`[${new Date().toISOString()}] backup ok -> ${dest} (${size} bytes)`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(`[${new Date().toISOString()}] backup FAILED: ${e.message}`);
    process.exit(1);
  });
