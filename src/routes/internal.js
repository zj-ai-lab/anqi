import { Router } from 'express';
import { db } from '../db.js';
import { buildDigest } from '../lib/digest.js';
import { enqueueLlmSuggestion, enqueueAgentProposal, releaseDueSnoozes } from '../lib/recommendations.js';

// 受信任自动化专用面。公网反向代理必须把 /internal/* 硬 404。
// 写入口只有 /inbox —— LLM 产物必须过收件箱人工裁决（铁律 3 的接口层强制）。
const r = Router();

r.get('/digest', (req, res) => res.json(buildDigest()));

r.get('/cases', (req, res) => {
  res.json(db.prepare("SELECT id, name, procedure, stage, status, case_no FROM cases ORDER BY (status='active') DESC, name").all());
});

r.get('/cases/byname/:name', (req, res) => {
  releaseDueSnoozes();
  const c = db.prepare('SELECT * FROM cases WHERE name = ?').get(req.params.name);
  if (!c) return res.status(404).json({ error: '案件不存在' });
  // ⚠️ 铁律 9 防回归：本响应面向 LLM，永不加入 contacts（电话/身份证）等当事人颗粒字段。
  res.json({
    case: c,
    events: db.prepare('SELECT * FROM events WHERE case_id = ? ORDER BY occurred_on DESC').all(c.id),
    deadlines: db.prepare('SELECT * FROM deadlines WHERE case_id = ? ORDER BY due_on').all(c.id),
    tasks: db.prepare("SELECT * FROM tasks WHERE case_id = ? AND status = 'open'").all(c.id),
    tasks_recent_closed: db.prepare(
      "SELECT * FROM tasks WHERE case_id=? AND status IN ('done','dropped') ORDER BY id DESC LIMIT 20"
    ).all(c.id),
    worklog_recent: db.prepare('SELECT * FROM worklog WHERE case_id = ? ORDER BY worked_on DESC LIMIT 10').all(c.id),
    recommendations_recent: db.prepare(
      `SELECT id,intent_key,payload,status,decision_reason,change_summary,seen_count,created_at,decided_at
         FROM inbox WHERE case_id=? AND source='llm-suggest'
        ORDER BY id DESC LIMIT 20`
    ).all(c.id).map((row) => {
      try { return { ...row, payload: JSON.parse(row.payload) }; } catch { return row; }
    }),
  });
});

r.post('/inbox', (req, res) => {
  const b = req.body || {};
  // 本路由是受信任 L2 自动化的单一用途写面：来源由服务端固定，绝不相信 body.source 选权限。
  if (b.kind !== 'task') return res.status(400).json({ error: 'internal inbox 只接受 LLM task 建议；期限只能由事件经引擎派生或人工录入' });
  if (!b.payload || typeof b.payload !== 'object') return res.status(400).json({ error: 'payload 须为对象' });
  if (b.source !== undefined && b.source !== 'llm-suggest') return res.status(400).json({ error: 'source 由服务端固定为 llm-suggest' });
  let caseId = b.case_id || null;
  if (!caseId && b.case_name) {
    const c = db.prepare('SELECT id FROM cases WHERE name = ?').get(b.case_name);
    if (!c) return res.status(404).json({ error: `案件不存在：${b.case_name}` });
    caseId = c.id;
  }
  if (!caseId) return res.status(400).json({ error: 'llm-suggest 必须关联案件' });
  try {
    const result = enqueueLlmSuggestion({
      payload: b.payload,
      sourceRef: b.source_ref || '',
      caseId,
      recommendation: b.recommendation,
    }, req.actor);
    return res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    return res.status(error.code === 'case_not_found' ? 404 : 400).json({
      error: error.message,
      code: error.code || 'recommendation_invalid',
    });
  }
});

// DSH agent 提案专用入口：与 /internal/inbox 分开，不复用其语义、不混入 case.next_action。
// 只收 supervisor 已绑定 case/session 的 task-only 建议——kind/event/deadline 一律拒绝；
// case_id、proposal_id、source_ref 由 supervisor 注入（不从模型正文推断），source 由服务端固定。
r.post('/agent-proposals', (req, res) => {
  const b = req.body || {};
  if (b.kind !== undefined && b.kind !== 'task') {
    return res.status(400).json({ error: 'agent-proposals 只接受 task-only 建议；event/deadline 一律拒绝' });
  }
  if (b.source !== undefined && b.source !== 'agent-propose') {
    return res.status(400).json({ error: 'source 由服务端固定为 agent-propose' });
  }
  if (!b.payload || typeof b.payload !== 'object' || Array.isArray(b.payload)) {
    return res.status(400).json({ error: 'payload 须为对象' });
  }
  const caseId = Number(b.case_id);
  if (!b.case_id || !Number.isInteger(caseId) || caseId <= 0) {
    return res.status(400).json({ error: 'agent-proposals 必须由 supervisor 注入合法 case_id' });
  }
  try {
    const result = enqueueAgentProposal({
      caseId,
      proposalId: b.proposal_id,
      payload: b.payload,
      sourceRef: b.source_ref,
    }, req.actor);
    return res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    return res.status(error.code === 'case_not_found' ? 404 : 400).json({
      error: error.message,
      code: error.code || 'proposal_invalid',
    });
  }
});

export default r;
