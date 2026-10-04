import { Router } from 'express';
import { db, audit } from '../db.js';

const r = Router();
const ROLES = ['合作律师', '对方律师', '其他'];

function text(value) { return String(value ?? '').trim(); }

function personBody(body = {}) {
  const name = text(body.name);
  if (!name) return { error: '姓名必填' };
  if (name.length > 100) return { error: '姓名过长' };
  return {
    name,
    phone: text(body.phone),
    org: text(body.org),
    note: text(body.note),
  };
}

function roleOf(value) {
  const role = text(value) || '合作律师';
  return ROLES.includes(role) ? role : null;
}

function personWithStats(row) {
  const cases = db.prepare(
    'SELECT COUNT(*) AS count FROM case_participants WHERE person_id = ?'
  ).get(row.id).count;
  const share = db.prepare(
    `SELECT
       COUNT(*) AS count,
       COUNT(DISTINCT case_id) AS case_count,
       COALESCE(SUM(CASE WHEN direction='receivable' AND status IN ('pending','settled') THEN amount ELSE 0 END),0) AS receivable,
       COALESCE(SUM(CASE WHEN direction='payable' AND status IN ('pending','settled') THEN amount ELSE 0 END),0) AS payable,
       MAX(COALESCE(NULLIF(due_month,''), substr(created_at,1,7))) AS last_month
       FROM fee_shares
      WHERE person_id = ? AND is_void = 0 AND cancelled_at = ''`
  ).get(row.id);
  return { ...row, case_count: Math.max(cases, share.case_count), participant_case_count: cases,
    share_count: share.count, share_case_count: share.case_count,
    receivable: share.receivable, payable: share.payable, last_month: share.last_month || '' };
}

function caseExists(caseId) {
  return db.prepare('SELECT id FROM cases WHERE id = ?').get(caseId);
}

function participant(caseId, personId) {
  return db.prepare(
    `SELECT cp.*, p.name, p.phone, p.org, p.note AS person_note
       FROM case_participants cp JOIN people p ON p.id = cp.person_id
      WHERE cp.case_id = ? AND cp.person_id = ?`
  ).get(caseId, personId);
}

export function participantForCase(personId, caseId) {
  const id = Number(personId);
  if (!Number.isInteger(id) || id <= 0) return { error: 'person_id 非法' };
  const row = participant(caseId, id);
  return row ? { row } : { error: '该对象尚未加入本案参与人' };
}

r.get('/people', (req, res) => {
  const rows = db.prepare('SELECT * FROM people ORDER BY name COLLATE NOCASE, id').all();
  res.json(rows.map(personWithStats));
});

r.post('/people', (req, res) => {
  const body = personBody(req.body);
  if (body.error) return res.status(400).json({ error: body.error });
  const existing = db.prepare('SELECT id FROM people WHERE name = ? COLLATE NOCASE AND phone = ?').get(body.name, body.phone);
  if (existing) return res.status(409).json({ error: '通讯录中已有同名同电话对象', code: 'person_exists', id: existing.id });
  const info = db.prepare(
    `INSERT INTO people (name, phone, org, note) VALUES (?, ?, ?, ?)`
  ).run(body.name, body.phone, body.org, body.note);
  audit(req.actor, 'create', 'person', info.lastInsertRowid, body.name);
  res.json(personWithStats(db.prepare('SELECT * FROM people WHERE id = ?').get(info.lastInsertRowid)));
});

r.patch('/people/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM people WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '通讯录对象不存在' });
  const next = { ...row };
  for (const field of ['name', 'phone', 'org', 'note']) if (field in (req.body || {})) next[field] = text(req.body[field]);
  if (!next.name) return res.status(400).json({ error: '姓名必填' });
  db.prepare(
    `UPDATE people SET name=?, phone=?, org=?, note=?, updated_at=datetime('now','+8 hours') WHERE id=?`
  ).run(next.name, next.phone, next.org, next.note, id);
  audit(req.actor, 'update', 'person', id, next.name);
  res.json(personWithStats(db.prepare('SELECT * FROM people WHERE id = ?').get(id)));
});

r.delete('/people/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM people WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '通讯录对象不存在' });
  const linked = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM case_participants WHERE person_id = ?) AS cases,
       (SELECT COUNT(*) FROM fee_shares WHERE person_id = ?) AS shares,
       (SELECT COUNT(*) FROM fee_share_agreements WHERE person_id = ?) AS agreements`
  ).get(id, id, id);
  if (linked.cases || linked.shares || linked.agreements) {
    return res.status(409).json({ error: '已有案件或分成记录，不能删除；可编辑备注保留历史', code: 'person_in_use' });
  }
  db.prepare('DELETE FROM people WHERE id = ?').run(id);
  audit(req.actor, 'delete', 'person', id, row.name);
  res.json({ ok: true });
});

r.get('/cases/:id/participants', (req, res) => {
  if (!caseExists(req.params.id)) return res.status(404).json({ error: '案件不存在' });
  res.json(db.prepare(
    `SELECT cp.id, cp.case_id, cp.person_id, cp.role, cp.note, cp.created_at,
            p.name, p.phone, p.org
       FROM case_participants cp JOIN people p ON p.id = cp.person_id
      WHERE cp.case_id = ? ORDER BY p.name COLLATE NOCASE, cp.id`
  ).all(req.params.id));
});

r.post('/cases/:id/participants', (req, res) => {
  const caseId = Number(req.params.id);
  if (!caseExists(caseId)) return res.status(404).json({ error: '案件不存在' });
  const personId = Number(req.body?.person_id);
  if (!Number.isInteger(personId) || personId <= 0 || !db.prepare('SELECT id FROM people WHERE id=?').get(personId)) {
    return res.status(400).json({ error: 'person_id 非法或对象不存在' });
  }
  const role = roleOf(req.body?.role);
  if (!role) return res.status(400).json({ error: `role 须为：${ROLES.join('/')}` });
  try {
    const info = db.prepare(
      'INSERT INTO case_participants (case_id, person_id, role, note) VALUES (?, ?, ?, ?)'
    ).run(caseId, personId, role, text(req.body?.note));
    audit(req.actor, 'create', 'case_participant', info.lastInsertRowid, `case:${caseId};person:${personId}`);
    res.json(participant(caseId, personId));
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: '该对象已经在本案参与人中', code: 'participant_exists' });
    throw error;
  }
});

r.patch('/cases/:id/participants/:personId', (req, res) => {
  const caseId = Number(req.params.id);
  const personId = Number(req.params.personId);
  const row = participant(caseId, personId);
  if (!row) return res.status(404).json({ error: '本案参与人不存在' });
  const role = 'role' in (req.body || {}) ? roleOf(req.body.role) : row.role;
  if (!role) return res.status(400).json({ error: `role 须为：${ROLES.join('/')}` });
  const note = 'note' in (req.body || {}) ? text(req.body.note) : row.note;
  db.prepare('UPDATE case_participants SET role=?, note=? WHERE id=?').run(role, note, row.id);
  audit(req.actor, 'update', 'case_participant', row.id, `case:${caseId};person:${personId}`);
  res.json(participant(caseId, personId));
});

r.delete('/cases/:id/participants/:personId', (req, res) => {
  const caseId = Number(req.params.id);
  const personId = Number(req.params.personId);
  const row = participant(caseId, personId);
  if (!row) return res.status(404).json({ error: '本案参与人不存在' });
  db.prepare('DELETE FROM case_participants WHERE id=?').run(row.id);
  audit(req.actor, 'delete', 'case_participant', row.id, `case:${caseId};person:${personId}`);
  res.json({ ok: true });
});

export default r;
