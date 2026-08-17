import { Router } from 'express';
import { db, audit } from '../db.js';

// 系统设置（键值）。当前只服务「用户中心 · 个人设置」的六个抬头字段——
// 纯展示信息，不进期限引擎、不进任何计算、无 LLM 通道。
//
// 白名单是硬门：PUT 只认下面这六个键，其余**直接丢弃**（不报错、不落库）。
// 这样前端将来多传字段不会写脏表，也不用担心有人拿它当任意 KV 存储。
const r = Router();

const ALLOWED = ['name', 'license_no', 'firm', 'phone', 'email', 'address'];

r.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json(Object.fromEntries(rows.map((row) => [row.key, row.value])));
});

r.put('/settings', (req, res) => {
  const body = req.body || {};
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  // 逐键 upsert，整体一个事务：要么六个键全落，要么一个都不落。
  const written = db.transaction((pairs) => {
    for (const [k, v] of pairs) upsert.run(k, v);
    return pairs.map(([k]) => k);
  })(
    ALLOWED
      .filter((k) => Object.prototype.hasOwnProperty.call(body, k))
      .map((k) => [k, String(body[k] ?? '')])
  );

  audit(req.actor, 'update', 'settings', null, written.join(','));
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json(Object.fromEntries(rows.map((row) => [row.key, row.value])));
});

export default r;
