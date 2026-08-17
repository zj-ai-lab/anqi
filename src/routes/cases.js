import { Router } from 'express';
import { db, audit } from '../db.js';
import { todayCN, isDate } from '../lib/dates.js';
import { normalizeCaseDirectoryName } from '../lib/secure-files.js';
import { procedures, stagesOf, tasksForStage } from '../lib/vocab.js';

const r = Router();

const EDITABLE = [
  'name', 'case_no', 'cause', 'court', 'client', 'client_role', 'opponent',
  'procedure', 'stage', 'status', 'accepted_at', 'folder_path', 'sol_starts_on', 'note', 'legalrag_url',
];

const LIST_SQL = `
  SELECT c.*,
    (SELECT MIN(due_on) FROM deadlines d WHERE d.case_id = c.id AND d.status = 'pending') AS next_due,
    (SELECT COUNT(*) FROM deadlines d WHERE d.case_id = c.id AND d.status = 'pending') AS pending_deadlines,
    (SELECT COUNT(*) FROM tasks t WHERE t.case_id = c.id AND t.status = 'open') AS open_tasks,
    CAST(julianday(date('now','+8 hours')) - julianday(c.stage_entered_at) AS INTEGER) AS stage_days
  FROM cases c`;

r.get('/cases', (req, res) => {
  const { q, status } = req.query;
  const cond = [];
  const args = [];
  if (status) { cond.push('c.status = ?'); args.push(status); }
  if (q) {
    cond.push('(c.name LIKE ? OR c.case_no LIKE ? OR c.client LIKE ? OR c.opponent LIKE ? OR c.cause LIKE ? OR c.court LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like, like, like, like);
  }
  const sql = LIST_SQL + (cond.length ? ' WHERE ' + cond.join(' AND ') : '') +
    " ORDER BY (c.status = 'active') DESC, COALESCE(NULLIF(next_due,''),'9999') ASC, c.updated_at DESC";
  res.json(db.prepare(sql).all(...args));
});

r.post('/cases', (req, res) => {
  const b = req.body || {};
  const caseName = normalizeCaseDirectoryName(b.name);
  if (!caseName) {
    return res.status(400).json({ error: 'name 必填，且须为单一、非隐藏的案件夹名称' });
  }
  const procedure = b.procedure || '一审';
  if (!procedures.includes(procedure)) return res.status(400).json({ error: `procedure 须为：${procedures.join('/')}` });
  const stages = stagesOf(procedure);
  const stage = b.stage && stages.includes(b.stage) ? b.stage : stages[0];
  if (b.accepted_at && !isDate(b.accepted_at)) return res.status(400).json({ error: 'accepted_at 须为 YYYY-MM-DD' });
  try {
    const info = db.prepare(
      `INSERT INTO cases (name, case_no, cause, court, client, client_role, opponent, procedure, stage, accepted_at, folder_path, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      caseName, b.case_no || '', b.cause || '', b.court || '', b.client || '', b.client_role || '',
      b.opponent || '', procedure, stage, b.accepted_at || '', b.folder_path || '', b.note || ''
    );
    audit(req.actor, 'create', 'case', info.lastInsertRowid, caseName);
    res.json(db.prepare('SELECT * FROM cases WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: '同名案件已存在' });
    throw e;
  }
});

r.get('/cases/:id', (req, res) => {
  const c = db.prepare(LIST_SQL + ' WHERE c.id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '案件不存在' });
  res.json({
    case: c,
    stages: stagesOf(c.procedure),
    events: db.prepare('SELECT * FROM events WHERE case_id = ? ORDER BY occurred_on DESC, id DESC').all(c.id),
    deadlines: db.prepare('SELECT * FROM deadlines WHERE case_id = ? ORDER BY due_on ASC').all(c.id),
    tasks: db.prepare("SELECT * FROM tasks WHERE case_id = ? ORDER BY status = 'open' DESC, COALESCE(NULLIF(due_on,''), NULLIF(plan_date,''), '9999')").all(c.id),
    worklog: db.prepare('SELECT * FROM worklog WHERE case_id = ? ORDER BY worked_on DESC, id DESC').all(c.id),
    attachments: db.prepare('SELECT * FROM attachments WHERE case_id = ? ORDER BY id DESC').all(c.id),
    contacts: db.prepare('SELECT * FROM contacts WHERE case_id = ? ORDER BY id').all(c.id),
  });
});

r.patch('/cases/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '案件不存在' });
  const b = req.body || {};
  const sets = [];
  const args = [];
  for (const f of EDITABLE) {
    if (!(f in b)) continue;
    if (f === 'name') {
      b[f] = normalizeCaseDirectoryName(b[f]);
      if (!b[f]) return res.status(400).json({ error: '案件名须为单一、非隐藏的案件夹名称' });
    }
    if (f === 'procedure' && !procedures.includes(b[f])) return res.status(400).json({ error: 'procedure 非法' });
    if (f === 'status' && !['active', 'shelved', 'closed'].includes(b[f])) return res.status(400).json({ error: 'status 非法' });
    sets.push(`${f} = ?`);
    args.push(b[f] ?? '');
  }
  if (!sets.length) return res.status(400).json({ error: '无可更新字段' });
  // 阶段真变化 → 重置停留计时（D6）
  const stageChanged = 'stage' in b && b.stage !== c.stage;
  if (stageChanged) {
    sets.push('stage_entered_at = ?');
    args.push(todayCN());
  }
  sets.push("updated_at = datetime('now','+8 hours')");
  try {
    db.prepare(`UPDATE cases SET ${sets.join(', ')} WHERE id = ?`).run(...args, c.id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: '同名案件已存在' });
    throw e;
  }
  audit(req.actor, 'update', 'case', c.id, Object.keys(b).join(','));

  // When/Then（D7）：进入新阶段 → 铺模板待办（幂等：同名 open 任务不重复）
  const templated = [];
  let stageChangeLog = null;
  if (stageChanged) {
    const proc = 'procedure' in b ? b.procedure : c.procedure;
    for (const title of tasksForStage(proc, b.stage)) {
      const dup = db.prepare("SELECT id FROM tasks WHERE case_id = ? AND title = ? AND status = 'open'").get(c.id, title);
      if (dup) continue;
      const info = db.prepare(
        "INSERT INTO tasks (case_id, title, stage, origin) VALUES (?, ?, ?, 'template')"
      ).run(c.id, title, b.stage);
      templated.push({ id: info.lastInsertRowid, title });
    }
    if (templated.length) audit(req.actor, 'stage-template-tasks', 'case', c.id, `${b.stage} +${templated.length}`);

    // 阶段变更留痕：写 worklog，时间线自动可见（与待办完成留痕同口径）
    const logContent = c.stage ? `阶段变更：${c.stage} → ${b.stage}` : `进入阶段：${b.stage}`;
    const logInfo = db.prepare(
      'INSERT INTO worklog (case_id, worked_on, content) VALUES (?, ?, ?)'
    ).run(c.id, todayCN(), logContent);
    stageChangeLog = db.prepare('SELECT * FROM worklog WHERE id = ?').get(logInfo.lastInsertRowid);
    audit(req.actor, 'create', 'worklog', logInfo.lastInsertRowid, `阶段变更 #${c.id} ${c.stage || '∅'}→${b.stage}`);
  }

  res.json({ ...db.prepare('SELECT * FROM cases WHERE id = ?').get(c.id), templated, stage_change_log: stageChangeLog });
});

export default r;
