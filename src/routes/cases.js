import { Router } from 'express';
import { db, audit, setChangeRuleId, withChangeContext } from '../db.js';
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
import { criminalFieldKeys, validateCriminalFields } from '../lib/case-fields.js';
import { missingConditions, conditionChangePreview, reconcileConditions, RULES, recomputeForDeadline, enrichDeadlineRow } from '../lib/engine.js';
import { computeElapsed } from '../lib/elapsed.js';

const FILES_ROOT = process.env.ANJIAN_FILES_ROOT || '';

import {CASE_TYPES, inferCaseType} from '../../public/js/case-types.js';
const EDITABLE = [ 'case_type',
  'name', 'case_no', 'cause', 'court', 'client', 'client_role', 'opponent',
  'procedure', 'stage', 'status', 'accepted_at', 'sol_starts_on', 'note', 'legalrag_url', 'reconsideration_precondition',
  ...criminalFieldKeys,
];

function normalizeCaseTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  if (!title || /[\x00-\x1f\x7f]/u.test(title) || Buffer.byteLength(title, 'utf8') > 500) return null;
  return title;
}

const LIST_SQL = `
  SELECT c.*,
    (SELECT MIN(due_on) FROM deadlines d WHERE d.case_id = c.id AND d.status = 'pending' AND d.advisory = 0) AS next_due,
    (SELECT COUNT(*) FROM deadlines d WHERE d.case_id = c.id AND d.status = 'pending' AND d.advisory = 0) AS pending_deadlines,
    (SELECT COUNT(*) FROM tasks t WHERE t.case_id = c.id AND t.status = 'open') AS open_tasks,
    CAST(julianday(date('now','+8 hours')) - julianday(c.stage_entered_at) AS INTEGER) AS stage_days
  FROM cases c`;

function workspaceOwner(directoryName, exceptCaseId = null) {
  const rows = db.prepare('SELECT id,name,folder_path FROM cases').all();
  return rows.find((row) => row.id !== exceptCaseId && caseDirectoryName(row) === directoryName) || null;
}

const DIRECT_LITIGATION_REASON = '复议前置：须先复议，直接起诉期限不适用';
const DIRECT_LITIGATION_RULES = new Set(RULES.filter((rule) => rule.direct_litigation).map((rule) => rule.id));

export function validatePrecondition(value) {
  return ['yes', 'no', 'unknown'].includes(value);
}

export function reconcilePrecondition(caseId, value, actor) {
  const direct = [...DIRECT_LITIGATION_RULES];
  if (!direct.length) return;
  const marks = direct.map(() => '?').join(',');
  if (value === 'yes') {
    const rows = db.prepare(`SELECT id, rule_id, name FROM deadlines
      WHERE case_id=? AND rule_id IN (${marks}) AND status='pending'`).all(caseId, ...direct);
    for (const row of rows) {
      setChangeRuleId(row.rule_id);
      db.prepare("UPDATE deadlines SET status='waived', suppressed_reason=? WHERE id=? AND status='pending'")
        .run(DIRECT_LITIGATION_REASON, row.id);
      audit(actor, 'suppress-precondition', 'deadline', row.id, DIRECT_LITIGATION_REASON);
    }
  } else {
    const rows = db.prepare(`SELECT * FROM deadlines
      WHERE case_id=? AND rule_id IN (${marks}) AND status='waived' AND suppressed_reason=?`)
      .all(caseId, ...direct, DIRECT_LITIGATION_REASON);
    for (const row of rows) {
      const next = recomputeForDeadline(row);
      setChangeRuleId(row.rule_id);
      if (next) {
        db.prepare("UPDATE deadlines SET status='pending', suppressed_reason=NULL, due_on=?, rolled_from=?, calc_note=? WHERE id=?")
          .run(next.due_on, next.rolled_from || '', next.calc_note, row.id);
      } else {
        db.prepare("UPDATE deadlines SET status='pending', suppressed_reason=NULL WHERE id=?").run(row.id);
      }
      audit(actor, 'restore-precondition', 'deadline', row.id, '复议前置标记解除，恢复直接起诉期限');
    }
  }
  setChangeRuleId(null);
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
  const fieldError = validateCriminalFields(b);
  if (fieldError) return res.status(400).json({ error: fieldError });
  const caseName = normalizeCaseTitle(b.name);
  if (!caseName) {
    return res.status(400).json({ error: 'name 必填' });
  }
  const procedure = b.procedure || '一审';
  const caseType=b.case_type??inferCaseType(procedure);
  if(!CASE_TYPES.includes(caseType))return res.status(400).json({error:'案件类型非法'});
  if (!procedures.includes(procedure)) return res.status(400).json({ error: `procedure 须为：${procedures.join('/')}` });
  const stages = stagesOf(procedure);
  const stage = b.stage && stages.includes(b.stage) ? b.stage : stages[0];
  if (b.accepted_at && !isDate(b.accepted_at)) return res.status(400).json({ error: 'accepted_at 须为 YYYY-MM-DD' });
  const reconsiderationPrecondition = Object.hasOwn(b, 'reconsideration_precondition')
    ? b.reconsideration_precondition : 'unknown';
  if (!validatePrecondition(reconsiderationPrecondition)) return res.status(400).json({ error: 'reconsideration_precondition 须为 yes/no/unknown' });
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
    const info = withChangeContext({ actor: req.actor }, () => {
      const inserted = db.prepare(
        `INSERT INTO cases (case_type, name, case_no, cause, court, client, client_role, opponent, procedure, stage, accepted_at, folder_path, note, reconsideration_precondition, ${criminalFieldKeys.join(',')})
         VALUES (${Array(14 + criminalFieldKeys.length).fill('?').join(',')})`
      ).run(
        caseType, caseName, b.case_no || '', b.cause || '', b.court || '', b.client || '', b.client_role || '',
        b.opponent || '', procedure, stage, b.accepted_at || '', folderPath, b.note || '', reconsiderationPrecondition,
        ...criminalFieldKeys.map(f => b[f] || '')
      );
      audit(req.actor, 'create', 'case', inserted.lastInsertRowid, `${caseName} workspace=${folderPath}`);
      return inserted;
    });
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
    // 身份上下文与业务写同事务（024）：改绑案件夹进 change_log 时能看出是哪个 actor 做的。
    withChangeContext({ actor: req.actor }, () => {
      db.prepare("UPDATE cases SET folder_path=?, updated_at=datetime('now','+8 hours') WHERE id=?")
        .run(folderPath, c.id);
      audit(req.actor, 'bind-workspace', 'case', c.id, `${previous || '(none)'} -> ${folderPath}`);
    });
  } catch (error) {
    if (createdDirectory) removeCreatedCaseDirectory(createdDirectory);
    throw error;
  }
  res.json({
    case: db.prepare('SELECT * FROM cases WHERE id = ?').get(c.id),
    workspace: { name: folderPath, exists: true, created: !!createdDirectory },
  });
});


r.post('/cases/batch-type', (req, res) => {
  const b = req.body || {};
  const caseType = b.case_type;
  if (!CASE_TYPES.includes(caseType)) return res.status(400).json({ error: '案件类型非法' });
  const raw = b.ids;
  if (!Array.isArray(raw) || raw.length === 0) return res.status(400).json({ error: 'ids 须为非空数组' });
  if (raw.length > 500) return res.status(400).json({ error: '单次最多 500 件' });
  const nums = raw.map((x) => Number(x));
  if (nums.some((n) => !Number.isInteger(n) || n <= 0)) return res.status(400).json({ error: 'ids 须为正整数' });
  const ids = [...new Set(nums)];
  const placeholders = ids.map(() => '?').join(',');
  const existing = db.prepare(`SELECT id, case_type FROM cases WHERE id IN (${placeholders})`).all(...ids);
  const found = new Set(existing.map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) return res.status(404).json({ error: '部分案件不存在', missing });

  const updated = [];
  const unchanged = [];
  withChangeContext({ actor: req.actor }, () => {
    for (const row of existing) {
      if (row.case_type === caseType) {
        unchanged.push(row.id);
        continue;
      }
      db.prepare("UPDATE cases SET case_type = ?, updated_at = datetime('now','+8 hours') WHERE id = ?").run(caseType, row.id);
      audit(req.actor, 'batch-case-type', 'case', row.id, `${row.case_type || '未分类'}→${caseType}`);
      updated.push(row.id);
    }
  });
  res.json({ updated, unchanged, case_type: caseType });
});

r.get('/cases/:id', (req, res) => {
  const c = db.prepare(LIST_SQL + ' WHERE c.id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '案件不存在' });
  const events = db.prepare('SELECT * FROM events WHERE case_id = ? ORDER BY occurred_on DESC, id DESC').all(c.id);
  res.json({
    case: c,
    condition_warnings: missingConditions(c, events),
    stages: stagesOf(c.procedure),
    events,
    elapsed: computeElapsed(c, process.env.NODE_ENV === 'test' && isDate(req.query.today) ? req.query.today : todayCN()),
    deadlines: db.prepare('SELECT * FROM deadlines WHERE case_id = ? ORDER BY due_on ASC').all(c.id).map(enrichDeadlineRow),
    tasks: db.prepare("SELECT * FROM tasks WHERE case_id = ? ORDER BY status = 'open' DESC, COALESCE(NULLIF(due_on,''), NULLIF(plan_date,''), '9999')").all(c.id),
    worklog: db.prepare('SELECT * FROM worklog WHERE case_id = ? ORDER BY worked_on DESC, id DESC').all(c.id),
    attachments: db.prepare('SELECT * FROM attachments WHERE case_id = ? ORDER BY id DESC').all(c.id),
    contacts: db.prepare('SELECT * FROM contacts WHERE case_id = ? ORDER BY id').all(c.id),
    participants: db.prepare(
      `SELECT cp.id, cp.case_id, cp.person_id, cp.role, cp.note, cp.created_at,
              p.name, p.phone, p.org
         FROM case_participants cp JOIN people p ON p.id = cp.person_id
        WHERE cp.case_id = ? ORDER BY p.name COLLATE NOCASE, cp.id`
    ).all(c.id),
  });
});

r.patch('/cases/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '案件不存在' });
  const b = req.body || {};
  const fieldError = validateCriminalFields(b);
  if (fieldError) return res.status(400).json({ error: fieldError });
  for (const f of ['accepted_at', 'sol_starts_on']) {
    if (f in b && b[f] && !isDate(b[f])) return res.status(400).json({ error: `${f} 须为 YYYY-MM-DD` });
  }
  const conditionChanged = ['procedure', 'crime_type', 'trial_mode', 'case_nature', 'custody_status'].some(f => f in b && b[f] !== c[f]);
  const reconsiderationChanged = 'reconsideration_precondition' in b && b.reconsideration_precondition !== c.reconsideration_precondition;
  if (reconsiderationChanged && !validatePrecondition(b.reconsideration_precondition)) {
    return res.status(400).json({ error: 'reconsideration_precondition 须为 yes/no/unknown' });
  }
  const nextCase = { ...c, ...Object.fromEntries(EDITABLE.filter(f => f in b).map(f => [f, b[f]])) };
  const preview = conditionChanged ? conditionChangePreview(nextCase) : null;
  const sets = [];
  const args = [];
  for (const f of EDITABLE) {
    if (!(f in b)) continue;
    if (f === 'name') {
      b[f] = normalizeCaseTitle(b[f]);
      if (!b[f]) return res.status(400).json({ error: '案件名不能为空' });
    }
    if(f === 'case_type' && !CASE_TYPES.includes(b[f]))return res.status(400).json({error:'案件类型非法'});
    if (f === 'procedure' && !procedures.includes(b[f])) return res.status(400).json({ error: 'procedure 非法' });
    if (f === 'status' && !['active', 'shelved', 'closed'].includes(b[f])) return res.status(400).json({ error: 'status 非法' });
    sets.push(`${f} = ?`);
    args.push(b[f] ?? '');
  }
  if (!sets.length) return res.status(400).json({ error: '无可更新字段' });
  if (preview && (preview.retire.length || preview.protected.length) && b.confirm_rederive !== true) {
    return res.json({ needs_confirm: true, condition_preview: preview });
  }

  // 阶段真变化 → 重置停留计时（D6）
  const stageChanged = 'stage' in b && b.stage !== c.stage;
  if (stageChanged) {
    sets.push('stage_entered_at = ?');
    args.push(todayCN());
  }
  sets.push("updated_at = datetime('now','+8 hours')");
  // When/Then（D7）：进入新阶段 → 铺模板待办（幂等：同名 open 任务不重复）
  const templated = [];
  let stageChangeLog = null;
  // 一次 PATCH 可能同时改案件字段、铺模板待办、写阶段变更日志——三处都属于同一个 actor、
  // 同一次操作，包在同一个事务里既是变更记录的需要，也让它们要么全成要么全不成。
  let nameConflict = false;
  let reconciled = null;
  withChangeContext({ actor: req.actor }, () => {
    try {
      db.prepare(`UPDATE cases SET ${sets.join(', ')} WHERE id = ?`).run(...args, c.id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) { nameConflict = true; return; }
      throw e;
    }
    audit(req.actor, 'update', 'case', c.id, Object.keys(b).join(','));
    if (conditionChanged) reconciled = reconcileConditions(db.prepare('SELECT * FROM cases WHERE id=?').get(c.id), req.actor, preview);
    if (reconsiderationChanged) reconcilePrecondition(c.id, b.reconsideration_precondition, req.actor);

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
  });
  if (nameConflict) return res.status(409).json({ error: '同名案件已存在' });

  res.json({ ...db.prepare('SELECT * FROM cases WHERE id = ?').get(c.id), templated, stage_change_log: stageChangeLog, reconciled });
});

  return r;
}

export default createCasesRouter;
