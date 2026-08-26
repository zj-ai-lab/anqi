import { Router } from 'express';
import { db, audit } from '../db.js';

// 联系人：人工 API 与 agent session 绑定写入口复用本文件同一套校验/落库函数。
// audit 不落号码明文，只记 role+姓名。
const r = Router();

const ROLES = ['当事人', '对方当事人', '承办法官', '法官助理', '书记员', '对方律师', '合作律师', '其他'];

function contactError(message, status = 400, code = 'contact_invalid') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function respondContactError(res, error) {
  return res.status(error.status || 400).json({ error: error.message, code: error.code || 'contact_invalid' });
}

export function upsertContactRecord({ caseId, payload, actor = 'web', createdBy = 'manual' }) {
  const c = db.prepare('SELECT id, name FROM cases WHERE id = ?').get(caseId);
  if (!c) throw contactError('案件不存在', 404, 'case_not_found');
  const b = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const rawId = b.id === undefined || b.id === null || b.id === '' ? null : Number(b.id);
  if (rawId !== null && (!Number.isInteger(rawId) || rawId <= 0)) {
    throw contactError('联系人 id 非法');
  }

  if (rawId === null) {
    if (!b.name || !String(b.name).trim()) throw contactError('姓名必填');
    if (!ROLES.includes(b.role)) throw contactError(`role 须为：${ROLES.join('/')}`);
    const info = db.prepare(
      `INSERT INTO contacts (case_id, role, name, phone, id_no, org, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      c.id, b.role, String(b.name).trim(), String(b.phone || ''), String(b.id_no || ''),
      String(b.org || ''), String(b.note || ''), createdBy
    );
    audit(actor, 'create', 'contact', info.lastInsertRowid, `${c.name} ${b.role}·${String(b.name).trim()}`);
    return { created: true, row: db.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid) };
  }

  const row = db.prepare('SELECT * FROM contacts WHERE id = ? AND case_id = ?').get(rawId, c.id);
  if (!row) throw contactError('联系人不存在', 404, 'contact_not_found');
  const sets = [];
  const args = [];
  for (const field of ['role', 'name', 'phone', 'id_no', 'org', 'note']) {
    if (!(field in b)) continue;
    if (field === 'role' && !ROLES.includes(b[field])) throw contactError('role 非法');
    if (field === 'name' && !String(b[field]).trim()) throw contactError('姓名必填');
    sets.push(`${field} = ?`);
    args.push(String(b[field] ?? '').trim());
  }
  if (!sets.length) throw contactError('无可更新字段');
  db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...args, row.id);
  audit(actor, 'update', 'contact', row.id, `${row.role}·${row.name}`);
  return { created: false, row: db.prepare('SELECT * FROM contacts WHERE id = ?').get(row.id) };
}

r.get('/cases/:id/contacts', (req, res) => {
  res.json(db.prepare('SELECT * FROM contacts WHERE case_id = ? ORDER BY id').all(req.params.id));
});

r.post('/cases/:id/contacts', (req, res) => {
  try {
    res.json(upsertContactRecord({ caseId: Number(req.params.id), payload: req.body, actor: req.actor }).row);
  } catch (error) {
    respondContactError(res, error);
  }
});

r.patch('/contacts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '联系人不存在' });
  try {
    res.json(upsertContactRecord({
      caseId: row.case_id,
      payload: { ...(req.body || {}), id: row.id },
      actor: req.actor,
      createdBy: row.created_by,
    }).row);
  } catch (error) {
    respondContactError(res, error);
  }
});

r.delete('/contacts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '联系人不存在' });
  db.prepare('DELETE FROM contacts WHERE id = ?').run(row.id);
  audit(req.actor, 'delete', 'contact', row.id, `${row.role}·${row.name}`);
  res.json({ ok: true });
});

export default r;
