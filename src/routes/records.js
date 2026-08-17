import { Router } from 'express';
import { db, audit, withImmediateTransaction } from '../db.js';
import { todayCN, isDate } from '../lib/dates.js';
import { isEventType } from '../lib/vocab.js';
import { deriveForEvent, recalcPreview, applyRecalc } from '../lib/engine.js';
import { parseQuick, llmReady } from '../lib/llm.js';

const r = Router();

function isTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function normalizedTaskDate(value) {
  return value ?? '';
}

function mustCase(id, res) {
  const c = db.prepare('SELECT id, name FROM cases WHERE id = ?').get(id);
  if (!c) res.status(404).json({ error: '案件不存在' });
  return c;
}

// ---------- events ----------
r.post('/cases/:id/events', (req, res) => {
  const c = mustCase(req.params.id, res);
  if (!c) return;
  const b = req.body || {};
  if (!isEventType(b.type)) return res.status(400).json({ error: 'type 非法（见 /api/meta 词表）' });
  if (!isDate(b.occurred_on)) return res.status(400).json({ error: 'occurred_on 须为 YYYY-MM-DD' });
  const info = db.prepare(
    `INSERT INTO events (case_id, type, occurred_on, service_method, instrument, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(c.id, b.type, b.occurred_on, b.service_method || '', b.instrument || '', b.note || '',
    ['manual', 'llm', 'import'].includes(b.created_by) ? b.created_by : 'manual');
  audit(req.actor, 'create', 'event', info.lastInsertRowid, `${c.name} ${b.type} ${b.occurred_on}`);
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(info.lastInsertRowid);
  // P1 引擎：触发事件 → 批量派生法定期限（D1）；court_specified → 铺录入任务
  const caseRow = db.prepare('SELECT * FROM cases WHERE id = ?').get(c.id);
  const derived = deriveForEvent(event, caseRow, req.actor);
  res.json({ ...event, derived });
});

r.patch('/events/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '事件不存在' });
  const b = req.body || {};

  // 改触发日期 → 级联重算，先出预览、confirm 才落库（D4：人工覆盖默认排除）
  const dateChanging = 'occurred_on' in b && b.occurred_on !== row.occurred_on;
  if (dateChanging) {
    if (!isDate(b.occurred_on)) return res.status(400).json({ error: '日期非法' });
    const preview = recalcPreview(row, b.occurred_on);
    if ((preview.recalc.length || preview.excluded.length) && b.confirm !== true) {
      return res.json({
        needs_confirm: true,
        event: { id: row.id, old_date: row.occurred_on, new_date: b.occurred_on },
        ...preview,
      });
    }
    if (b.confirm === true) applyRecalc(preview, req.actor);
  }

  const sets = [];
  const args = [];
  for (const f of ['type', 'occurred_on', 'service_method', 'instrument', 'note']) {
    if (!(f in b)) continue;
    if (f === 'type' && !isEventType(b.type)) return res.status(400).json({ error: 'type 非法' });
    if (f === 'occurred_on' && !isDate(b.occurred_on)) return res.status(400).json({ error: '日期非法' });
    sets.push(`${f} = ?`);
    args.push(b[f] ?? '');
  }
  if (!sets.length) return res.status(400).json({ error: '无可更新字段' });
  db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...args, row.id);
  audit(req.actor, 'update', 'event', row.id, Object.keys(b).join(','));
  res.json(db.prepare('SELECT * FROM events WHERE id = ?').get(row.id));
});

r.delete('/events/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '事件不存在' });
  const linked = db.prepare('SELECT COUNT(*) c FROM deadlines WHERE trigger_event_id = ?').get(row.id).c;
  if (linked) return res.status(409).json({ error: `有 ${linked} 条期限挂在该事件上，先处理期限` });
  db.prepare('DELETE FROM events WHERE id = ?').run(row.id);
  audit(req.actor, 'delete', 'event', row.id, `${row.type} ${row.occurred_on}`);
  res.json({ ok: true });
});

// ---------- deadlines（P0 全手动：is_manual_override=1，P1 引擎生成的才为 0）----------
r.post('/cases/:id/deadlines', (req, res) => {
  const c = mustCase(req.params.id, res);
  if (!c) return;
  const b = req.body || {};
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'name 必填' });
  if (!isDate(b.due_on)) return res.status(400).json({ error: 'due_on 须为 YYYY-MM-DD' });
  const severity = ['critical', 'high', 'normal'].includes(b.severity) ? b.severity : 'normal';
  const info = db.prepare(
    `INSERT INTO deadlines (case_id, name, due_on, trigger_event_id, basis, calc_note, is_manual_override, severity)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(c.id, b.name.trim(), b.due_on, b.trigger_event_id || null, b.basis || '', b.calc_note || '', severity);
  audit(req.actor, 'create', 'deadline', info.lastInsertRowid, `${c.name} ${b.name} ${b.due_on}`);
  res.json(db.prepare('SELECT * FROM deadlines WHERE id = ?').get(info.lastInsertRowid));
});

r.patch('/deadlines/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM deadlines WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '期限不存在' });
  const b = req.body || {};
  const sets = [];
  const args = [];
  for (const f of ['name', 'due_on', 'basis', 'calc_note', 'severity', 'status']) {
    if (!(f in b)) continue;
    if (f === 'due_on' && !isDate(b.due_on)) return res.status(400).json({ error: '日期非法' });
    if (f === 'severity' && !['critical', 'high', 'normal'].includes(b.severity)) return res.status(400).json({ error: 'severity 非法' });
    if (f === 'status' && !['pending', 'done', 'missed', 'waived'].includes(b.status)) return res.status(400).json({ error: 'status 非法' });
    sets.push(`${f} = ?`);
    args.push(b[f] ?? '');
  }
  if (!sets.length) return res.status(400).json({ error: '无可更新字段' });
  // 人工改动到期日 → 标记 override（D4：级联重算默认排除）
  if ('due_on' in b && b.due_on !== row.due_on) {
    sets.push('is_manual_override = 1');
  }
  if ('status' in b && b.status === 'done' && row.status !== 'done') {
    sets.push("done_at = datetime('now','+8 hours')");
  }
  db.prepare(`UPDATE deadlines SET ${sets.join(', ')} WHERE id = ?`).run(...args, row.id);
  audit(req.actor, 'update', 'deadline', row.id, Object.keys(b).join(','));
  res.json(db.prepare('SELECT * FROM deadlines WHERE id = ?').get(row.id));
});

r.delete('/deadlines/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM deadlines WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '期限不存在' });
  db.prepare('UPDATE tasks SET deadline_id = NULL WHERE deadline_id = ?').run(row.id);
  db.prepare('DELETE FROM deadlines WHERE id = ?').run(row.id);
  audit(req.actor, 'delete', 'deadline', row.id, `${row.name} ${row.due_on}`);
  res.json({ ok: true });
});

// ---------- tasks ----------
r.get('/tasks', (req, res) => {
  const { status = 'open', case_id } = req.query;
  const cond = [];
  const args = [];
  if (status !== 'all') { cond.push('t.status = ?'); args.push(status); }
  if (case_id) { cond.push('t.case_id = ?'); args.push(case_id); }
  const sql = `SELECT t.*, c.name AS case_name FROM tasks t LEFT JOIN cases c ON c.id = t.case_id
    ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
    ORDER BY COALESCE(NULLIF(t.due_on,''), NULLIF(t.plan_date,''), '9999'),
      CASE WHEN t.due_time = '' THEN 1 ELSE 0 END, t.due_time,
      t.priority = 'high' DESC, t.id DESC`;
  res.json(db.prepare(sql).all(...args));
});

r.post('/tasks', (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.title.trim()) return res.status(400).json({ error: 'title 必填' });
  const planDate = normalizedTaskDate(b.plan_date);
  const dueOn = normalizedTaskDate(b.due_on);
  const dueTime = normalizedTaskDate(b.due_time);
  for (const [field, value] of [['plan_date', planDate], ['due_on', dueOn]]) {
    if (value !== '' && !isDate(value)) return res.status(400).json({ error: `${field} 须为 YYYY-MM-DD` });
  }
  if (planDate && dueOn && planDate > dueOn) {
    return res.status(400).json({ error: 'plan_date 不得晚于 due_on' });
  }
  if (dueTime !== '' && !isTime(dueTime)) return res.status(400).json({ error: 'due_time 须为 HH:MM' });
  if (dueTime && !dueOn) return res.status(400).json({ error: 'due_time 需要先填写 due_on' });
  if (b.case_id && !db.prepare('SELECT id FROM cases WHERE id = ?').get(b.case_id)) {
    return res.status(404).json({ error: '案件不存在' });
  }
  const info = db.prepare(
    `INSERT INTO tasks (case_id, title, plan_date, due_on, due_time, deadline_id, stage, priority, origin, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    b.case_id || null, b.title.trim(), planDate, dueOn, dueTime, b.deadline_id || null,
    b.stage || '', ['high', 'normal', 'low'].includes(b.priority) ? b.priority : 'normal',
    ['manual', 'template', 'llm'].includes(b.origin) ? b.origin : 'manual', b.note || ''
  );
  audit(req.actor, 'create', 'task', info.lastInsertRowid, b.title.trim());
  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid));
});

r.patch('/tasks/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '待办不存在' });
  const b = req.body || {};
  const sets = [];
  const args = [];
  const hasPlanDate = Object.hasOwn(b, 'plan_date');
  const hasDueOn = Object.hasOwn(b, 'due_on');
  const hasDueTime = Object.hasOwn(b, 'due_time');
  let planDate = hasPlanDate ? normalizedTaskDate(b.plan_date) : row.plan_date;
  let dueOn = hasDueOn ? normalizedTaskDate(b.due_on) : row.due_on;
  let dueTime = hasDueTime ? normalizedTaskDate(b.due_time) : row.due_time;
  let clampedPlanDate = false;
  let clampedDueOn = false;
  for (const [field, value] of [['plan_date', planDate], ['due_on', dueOn]]) {
    if (value !== '' && !isDate(value)) return res.status(400).json({ error: `${field} 须为 YYYY-MM-DD` });
  }
  if (hasPlanDate && hasDueOn && planDate && dueOn && planDate > dueOn) {
    return res.status(400).json({ error: 'plan_date 不得晚于 due_on' });
  }
  if (hasPlanDate && !hasDueOn && planDate && dueOn && planDate > dueOn) {
    dueOn = planDate;
    clampedDueOn = true;
  }
  if (!hasPlanDate && hasDueOn && planDate && dueOn && planDate > dueOn) {
    planDate = dueOn;
    clampedPlanDate = true;
  }
  if (dueTime !== '' && !isTime(dueTime)) return res.status(400).json({ error: 'due_time 须为 HH:MM' });
  if (dueTime && !dueOn && hasDueTime) return res.status(400).json({ error: 'due_time 需要先填写 due_on' });
  if (!dueOn) dueTime = '';
  if (hasPlanDate) { sets.push('plan_date = ?'); args.push(planDate); }
  if (hasDueOn || clampedDueOn) { sets.push('due_on = ?'); args.push(dueOn); }
  if (clampedPlanDate && !hasPlanDate) { sets.push('plan_date = ?'); args.push(planDate); }
  if (hasDueTime || (!dueOn && row.due_time)) { sets.push('due_time = ?'); args.push(dueTime); }
  for (const f of ['title', 'priority', 'status', 'note', 'stage']) {
    if (!(f in b)) continue;
    if (f === 'status' && !['open', 'done', 'dropped'].includes(b.status)) return res.status(400).json({ error: 'status 非法' });
    if (f === 'priority' && !['high', 'normal', 'low'].includes(b.priority)) return res.status(400).json({ error: 'priority 非法' });
    sets.push(`${f} = ?`);
    args.push(b[f] ?? '');
  }
  if (!sets.length) return res.status(400).json({ error: '无可更新字段' });
  const wantsDone = b.status === 'done';
  let updated;
  let completionWorklog = null;
  withImmediateTransaction(() => {
    const current = db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
    const txSets = [...sets];
    const txArgs = [...args];
    const isCompleting = wantsDone && current.status !== 'done';
    if (isCompleting) txSets.push("done_at = datetime('now','+8 hours')");
    db.prepare(`UPDATE tasks SET ${txSets.join(', ')} WHERE id = ?`).run(...txArgs, row.id);
    updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
    audit(req.actor, 'update', 'task', row.id, Object.keys(b).join(','));
    if (isCompleting) {
      const content = `完成待办：${updated.title}`;
      const info = db.prepare(
        'INSERT INTO worklog (case_id, worked_on, content) VALUES (?, ?, ?)'
      ).run(updated.case_id, todayCN(), content);
      completionWorklog = db.prepare('SELECT * FROM worklog WHERE id = ?').get(info.lastInsertRowid);
      audit(req.actor, 'create', 'worklog', info.lastInsertRowid, `待办完成 #${row.id} ${updated.title}`);
    }
  });
  res.json({ ...updated, completion_worklog: completionWorklog });
});

r.delete('/tasks/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '待办不存在' });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(row.id);
  audit(req.actor, 'delete', 'task', row.id, row.title);
  res.json({ ok: true });
});

// ---------- worklog ----------
r.post('/worklog', (req, res) => {
  const b = req.body || {};
  if (!b.content || !b.content.trim()) return res.status(400).json({ error: 'content 必填' });
  const workedOn = b.worked_on || todayCN();
  if (!isDate(workedOn)) return res.status(400).json({ error: 'worked_on 须为 YYYY-MM-DD' });
  if (b.case_id && !db.prepare('SELECT id FROM cases WHERE id = ?').get(b.case_id)) {
    return res.status(404).json({ error: '案件不存在' });
  }
  const info = db.prepare(
    'INSERT INTO worklog (case_id, worked_on, content, minutes, artifacts) VALUES (?, ?, ?, ?, ?)'
  ).run(b.case_id || null, workedOn, b.content.trim(), Number.isInteger(b.minutes) ? b.minutes : null, b.artifacts || '');
  audit(req.actor, 'create', 'worklog', info.lastInsertRowid, b.content.slice(0, 50));
  res.json(db.prepare('SELECT * FROM worklog WHERE id = ?').get(info.lastInsertRowid));
});

r.patch('/worklog/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM worklog WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '日志不存在' });
  const b = req.body || {};
  const sets = [];
  const args = [];
  for (const f of ['worked_on', 'content', 'minutes', 'artifacts']) {
    if (!(f in b)) continue;
    if (f === 'worked_on' && !isDate(b[f])) return res.status(400).json({ error: '日期非法' });
    sets.push(`${f} = ?`);
    args.push(b[f] ?? '');
  }
  if (!sets.length) return res.status(400).json({ error: '无可更新字段' });
  db.prepare(`UPDATE worklog SET ${sets.join(', ')} WHERE id = ?`).run(...args, row.id);
  audit(req.actor, 'update', 'worklog', row.id, '');
  res.json(db.prepare('SELECT * FROM worklog WHERE id = ?').get(row.id));
});

r.delete('/worklog/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM worklog WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '日志不存在' });
  db.prepare('DELETE FROM worklog WHERE id = ?').run(row.id);
  audit(req.actor, 'delete', 'worklog', row.id, row.content.slice(0, 50));
  res.json({ ok: true });
});

// ---------- 快录（P3/P5：方律本人直录不过收件箱）----------
r.post('/quick', (req, res) => {
  const b = req.body || {};
  const kind = b.kind === 'log' ? 'log' : 'task';
  if (!b.text || !b.text.trim()) return res.status(400).json({ error: 'text 必填' });
  if (b.date && !isDate(b.date)) return res.status(400).json({ error: 'date 须为 YYYY-MM-DD' });
  if (b.case_id && !db.prepare('SELECT id FROM cases WHERE id = ?').get(b.case_id)) {
    return res.status(404).json({ error: '案件不存在' });
  }
  if (kind === 'log') {
    const info = db.prepare('INSERT INTO worklog (case_id, worked_on, content) VALUES (?, ?, ?)')
      .run(b.case_id || null, b.date || todayCN(), b.text.trim());
    audit(req.actor, 'create', 'worklog', info.lastInsertRowid, 'quick');
    return res.json({ kind: 'log', row: db.prepare('SELECT * FROM worklog WHERE id = ?').get(info.lastInsertRowid) });
  }
  const info = db.prepare('INSERT INTO tasks (case_id, title, plan_date) VALUES (?, ?, ?)')
    .run(b.case_id || null, b.text.trim(), b.date || '');
  audit(req.actor, 'create', 'task', info.lastInsertRowid, 'quick');
  res.json({ kind: 'task', row: db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid) });
});

// ---- 快录整理（1.1.0）：LLM 把一句话整理成建议，**只回给前端填表，绝不写库** ----
// 人按「记」才走上面的 /quick 入表 —— 那一按就是铁律要的「人工确认」。
// 收件箱是**异步** LLM 产物（后台提取时人不在场）的裁决通道；这里是**同步**辅助，
// 两条路的共同不变量：LLM 的产物永不自己落库。见 DESIGN.md §8.6。

/** 本地匹配案件：LLM 只给「线索字符串」，真正认案件的是这里——案件名单绝不出机 */
function matchCase(hint) {
  const h = String(hint || '').trim();
  if (h.length < 2) return null;                    // 一个字的线索必然歧义，直接放弃
  const rows = db.prepare(
    "SELECT id, name, client, opponent, case_no FROM cases WHERE status = 'active'"
  ).all();
  const hit = (c) => [c.name, c.client, c.opponent, c.case_no]
    .filter(Boolean)
    .some((f) => f.includes(h) || h.includes(f));
  const found = rows.filter(hit);
  // 只认唯一命中。多个案件都沾边时宁可留空让人选，也不替人做二选一——挂错案件比没挂更糟。
  return found.length === 1 ? found[0] : null;
}

r.post('/quick/parse', async (req, res) => {
  if (!llmReady()) return res.status(503).json({ error: '未配置 DEEPSEEK_API_KEY（快录整理不可用，手动录入不受影响）' });
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'text 必填' });

  let out;
  try {
    out = await parseQuick(text, todayCN());
  } catch (e) {
    return res.status(502).json({ error: e.message });   // 上游挂了 = 前端退回手填，不阻塞录入
  }

  // ── 一个字都不信 LLM：逐字段白名单校验，越界一律降级为空，绝不透传 ──
  const kind = out.kind === 'log' ? 'log' : 'task';       // 白名单闭合：结构上不可能产出 deadline（铁律①）
  let title = String(out.title || '').trim().slice(0, 200);
  if (!title) title = text;                               // LLM 没给标题就退回原文，不能把人的输入弄丢
  const date = isDate(out.date) ? out.date : '';          // 非法/瞎猜的日期直接丢掉，让人自己填
  const c = matchCase(out.case_hint);

  audit(req.actor, 'parse', 'quick', null, `llm:${kind}${c ? ' →' + c.name : ''}`);
  res.json({
    kind,
    title,
    date,
    case_id: c ? c.id : null,
    case_name: c ? c.name : '',
    case_hint: String(out.case_hint || '').slice(0, 60),  // 没匹配上时回显线索，让人知道它「以为」是哪个案子
    source_text: text,
  });
});

export default r;
