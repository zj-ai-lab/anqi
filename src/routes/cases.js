import { Router } from 'express';
import { db, audit } from '../db.js';
import { todayCN, isDate } from '../lib/dates.js';
import {
  caseDirectoryName,
  ensureCaseDirectory,
  listCaseDirectories,
  normalizeCaseDirectoryName,
  removeCreatedCaseDirectory,
  resolveCaseDirectory,
} from '../lib/secure-files.js';
import { procedures, stagesOf, tasksForStage } from '../lib/vocab.js';

const FILES_ROOT = process.env.ANJIAN_FILES_ROOT || '';

const EDITABLE = [
  'name', 'case_no', 'cause', 'court', 'client', 'client_role', 'opponent',
  'procedure', 'stage', 'status', 'accepted_at', 'sol_starts_on', 'note', 'legalrag_url',
];

function normalizeCaseTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  if (!title || /[\x00-\x1f\x7f]/u.test(title) || Buffer.byteLength(title, 'utf8') > 500) return null;
  return title;
}

const LIST_SQL = `
  SELECT c.*,
    (SELECT MIN(due_on) FROM deadlines d WHERE d.case_id = c.id AND d.status = 'pending') AS next_due,
    (SELECT COUNT(*) FROM deadlines d WHERE d.case_id = c.id AND d.status = 'pending') AS pending_deadlines,
    (SELECT COUNT(*) FROM tasks t WHERE t.case_id = c.id AND t.status = 'open') AS open_tasks,
    CAST(julianday(date('now','+8 hours')) - julianday(c.stage_entered_at) AS INTEGER) AS stage_days
  FROM cases c`;

function workspaceOwner(directoryName, exceptCaseId = null) {
  const rows = db.prepare('SELECT id,name,folder_path FROM cases').all();
  return rows.find((row) => row.id !== exceptCaseId && caseDirectoryName(row) === directoryName) || null;
}

function workspacePayload() {
  if (!FILES_ROOT) return { configured: false, folders: [] };
  const { names } = listCaseDirectories(FILES_ROOT);
  const cases = db.prepare('SELECT id,name,folder_path FROM cases ORDER BY id').all();
  const bindings = new Map(cases.map((row) => [caseDirectoryName(row), row]));
  return {
    configured: true,
    folders: names.map((name) => {
      const owner = bindings.get(name);
      return {
        name,
        bound_case_id: owner?.id ?? null,
        bound_case_name: owner?.name ?? '',
      };
    }),
  };
}

export function createCasesRouter(supervisor) {
  const r = Router();

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

// 案件工作区选择器的数据源：只暴露配置根下的单层真实目录，不接受/返回任意
// 宿主绝对路径。未配置文件根时返回空能力而不是让整个案件模块不可用。
r.get('/case-folders', (req, res) => {
  try {
    res.json(workspacePayload());
  } catch (error) {
    if (['root_unavailable', 'root_invalid'].includes(error?.code)) {
      return res.status(503).json({ error: error.message });
    }
    throw error;
  }
});

r.post('/cases', (req, res) => {
  const b = req.body || {};
  const caseName = normalizeCaseTitle(b.name);
  if (!caseName) {
    return res.status(400).json({ error: 'name 必填' });
  }
  const procedure = b.procedure || '一审';
  if (!procedures.includes(procedure)) return res.status(400).json({ error: `procedure 须为：${procedures.join('/')}` });
  const stages = stagesOf(procedure);
  const stage = b.stage && stages.includes(b.stage) ? b.stage : stages[0];
  if (b.accepted_at && !isDate(b.accepted_at)) return res.status(400).json({ error: 'accepted_at 须为 YYYY-MM-DD' });
  const folderPath = normalizeCaseDirectoryName(b.folder_path || caseName);
  if (!folderPath) return res.status(400).json({ error: 'folder_path 须为文件根下的单层、非隐藏目录名' });
  const owner = workspaceOwner(folderPath);
  if (owner) return res.status(409).json({ error: `案件夹「${folderPath}」已绑定到「${owner.name}」` });

  let createdDirectory = null;
  try {
    if (FILES_ROOT) {
      const ensured = ensureCaseDirectory(FILES_ROOT, folderPath);
      if (ensured.created) createdDirectory = ensured.context;
    }
    const info = db.prepare(
      `INSERT INTO cases (name, case_no, cause, court, client, client_role, opponent, procedure, stage, accepted_at, folder_path, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      caseName, b.case_no || '', b.cause || '', b.court || '', b.client || '', b.client_role || '',
      b.opponent || '', procedure, stage, b.accepted_at || '', folderPath, b.note || ''
    );
    audit(req.actor, 'create', 'case', info.lastInsertRowid, `${caseName} workspace=${folderPath}`);
    res.json(db.prepare('SELECT * FROM cases WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    if (createdDirectory) removeCreatedCaseDirectory(createdDirectory);
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: '同名案件已存在' });
    if (['root_unconfigured', 'root_unavailable', 'root_invalid', 'invalid_case_name', 'symlink', 'escape', 'not_directory'].includes(e?.code)) {
      return res.status(400).json({ error: e.message });
    }
    throw e;
  }
});

r.put('/cases/:id/workspace', async (req, res) => {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '案件不存在' });
  if (!FILES_ROOT) return res.status(503).json({ error: '未配置文件根（ANJIAN_FILES_ROOT）' });
  const folderPath = normalizeCaseDirectoryName(req.body?.folder_path);
  if (!folderPath) return res.status(400).json({ error: 'folder_path 须为文件根下的单层、非隐藏目录名' });
  const owner = workspaceOwner(folderPath, c.id);
  if (owner) return res.status(409).json({ error: `案件夹「${folderPath}」已绑定到「${owner.name}」` });

  let context;
  let createdDirectory = null;
  try {
    if (req.body?.create === true) {
      const ensured = ensureCaseDirectory(FILES_ROOT, folderPath);
      context = ensured.context;
      if (ensured.created) createdDirectory = context;
    } else {
      context = resolveCaseDirectory(FILES_ROOT, folderPath);
      if (!context.exists) return res.status(404).json({ error: `案件夹不存在：${folderPath}` });
    }
  } catch (error) {
    if (['root_unconfigured', 'root_unavailable', 'root_invalid'].includes(error?.code)) {
      return res.status(503).json({ error: error.message });
    }
    if (['invalid_case_name', 'symlink', 'escape', 'not_directory'].includes(error?.code)) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }

  const previous = caseDirectoryName(c);
  if (previous !== folderPath && supervisor && typeof supervisor.stop === 'function') {
    try { await supervisor.stop(c.id, 'case-workspace-rebound'); } catch { /* stop() 自带强杀兜底 */ }
  }
  // stop() 是异步的；等待期间另一个请求可能已抢先绑定同一目录。更新前重新
  // 核验一次，让 Node 单进程内最后的 owner-check + 同步 SQLite update 连续完成。
  const racedOwner = workspaceOwner(folderPath, c.id);
  if (racedOwner) {
    return res.status(409).json({ error: `案件夹「${folderPath}」已绑定到「${racedOwner.name}」` });
  }
  try {
    db.prepare("UPDATE cases SET folder_path=?, updated_at=datetime('now','+8 hours') WHERE id=?")
      .run(folderPath, c.id);
  } catch (error) {
    if (createdDirectory) removeCreatedCaseDirectory(createdDirectory);
    throw error;
  }
  audit(req.actor, 'bind-workspace', 'case', c.id, `${previous || '(none)'} -> ${folderPath}`);
  res.json({
    case: db.prepare('SELECT * FROM cases WHERE id = ?').get(c.id),
    workspace: { name: folderPath, exists: true, created: !!createdDirectory },
  });
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
      b[f] = normalizeCaseTitle(b[f]);
      if (!b[f]) return res.status(400).json({ error: '案件名不能为空' });
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

  return r;
}

export default createCasesRouter;
