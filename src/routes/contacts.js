import { Router } from 'express';
import { db, audit } from '../db.js';

// 联系人（敏感层级最高：电话/身份证）。只挂 /api（人用）；
// ⚠️ 铁律 9：永不把本表加进 /internal 任何响应（internal.js 有对应防回归注释）。
// audit 不落号码明文，只记 role+姓名。
const r = Router();

const ROLES = ['当事人', '对方当事人', '承办法官', '法官助理', '书记员', '对方律师', '合作律师', '其他'];

r.get('/cases/:id/contacts', (req, res) => {
  res.json(db.prepare('SELECT * FROM contacts WHERE case_id = ? ORDER BY id').all(req.params.id));
});

r.post('/cases/:id/contacts', (req, res) => {
  const c = db.prepare('SELECT id, name FROM cases WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '案件不存在' });
  const b = req.body || {};
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: '姓名必填' });
  if (!ROLES.includes(b.role)) return res.status(400).json({ error: `role 须为：${ROLES.join('/')}` });
  const info = db.prepare(
    'INSERT INTO contacts (case_id, role, name, phone, id_no, org, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(c.id, b.role, b.name.trim(), b.phone || '', b.id_no || '', b.org || '', b.note || '');
  audit(req.actor, 'create', 'contact', info.lastInsertRowid, `${c.name} ${b.role}·${b.name.trim()}`);
  res.json(db.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid));
});

r.patch('/contacts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '联系人不存在' });
  const b = req.body || {};
  const sets = [];
  const args = [];
  for (const f of ['role', 'name', 'phone', 'id_no', 'org', 'note']) {
    if (!(f in b)) continue;
    if (f === 'role' && !ROLES.includes(b[f])) return res.status(400).json({ error: 'role 非法' });
    if (f === 'name' && !String(b[f]).trim()) return res.status(400).json({ error: '姓名必填' });
    sets.push(`${f} = ?`);
    args.push(String(b[f] ?? '').trim());
  }
  if (!sets.length) return res.status(400).json({ error: '无可更新字段' });
  db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...args, row.id);
  audit(req.actor, 'update', 'contact', row.id, `${row.role}·${row.name}`);
  res.json(db.prepare('SELECT * FROM contacts WHERE id = ?').get(row.id));
});

r.delete('/contacts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '联系人不存在' });
  db.prepare('DELETE FROM contacts WHERE id = ?').run(row.id);
  audit(req.actor, 'delete', 'contact', row.id, `${row.role}·${row.name}`);
  res.json({ ok: true });
});

export default r;
