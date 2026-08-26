import { Router } from 'express';
import { db, audit } from '../db.js';
import { buildDigest } from '../lib/digest.js';
import { enqueueLlmSuggestion, enqueueAgentProposal, releaseDueSnoozes } from '../lib/recommendations.js';
import { caseIdForSession } from '../agent/session-registry.js';
import { upsertContactRecord } from './contacts.js';
import { createDeadlineRecord, createEventRecord, createTaskRecord } from './records.js';
import { createFactRecord } from './legalrag.js';

// 受信任自动化专用面。公网反向代理必须把 /internal/* 硬 404。
// /inbox 继续承载软建议；/agent-proposals 同一路径按 mode 区分软建议与 session
// 绑定直写，桌面自动 key 不需要扩大到其它 internal 路径。
const r = Router();

r.get('/digest', (req, res) => res.json(buildDigest()));

r.get('/cases', (req, res) => {
  res.json(db.prepare("SELECT id, name, procedure, stage, status, case_no FROM cases ORDER BY (status='active') DESC, name").all());
});

// /cases/byname/:name 与 /agent-case-view 共用同一份案件全景查询——两条路由的
// 区别只在"案件怎么来"（前者信任 name 参数、面向外部自动化；后者按 session
// 反查、面向 DSH agent worker），返回形状必须逐字段一致，不允许两处各写一份、
// 悄悄跑偏。当前单用户自托管策略允许绑定案的 agent 读写联系人；case_id 仍只
// 来自 session registry，绝不因开放 contacts 而放宽跨案边界。
function buildCaseView(c) {
  return {
    case: c,
    contacts: db.prepare('SELECT * FROM contacts WHERE case_id = ? ORDER BY id').all(c.id),
    facts: db.prepare(
      "SELECT * FROM facts WHERE case_id=? ORDER BY COALESCE(NULLIF(occurred_on,''),'9999-12-31') DESC,id DESC"
    ).all(c.id),
    events: db.prepare('SELECT * FROM events WHERE case_id = ? ORDER BY occurred_on DESC').all(c.id),
    deadlines: db.prepare('SELECT * FROM deadlines WHERE case_id = ? ORDER BY due_on').all(c.id),
    tasks: db.prepare("SELECT *, origin AS created_by FROM tasks WHERE case_id = ? AND status = 'open'").all(c.id),
    tasks_recent_closed: db.prepare(
      "SELECT *, origin AS created_by FROM tasks WHERE case_id=? AND status IN ('done','dropped') ORDER BY id DESC LIMIT 20"
    ).all(c.id),
    worklog_recent: db.prepare('SELECT * FROM worklog WHERE case_id = ? ORDER BY worked_on DESC LIMIT 10').all(c.id),
    recommendations_recent: db.prepare(
      `SELECT id,intent_key,payload,status,decision_reason,change_summary,seen_count,created_at,decided_at
         FROM inbox WHERE case_id=? AND source='llm-suggest'
        ORDER BY id DESC LIMIT 20`
    ).all(c.id).map((row) => {
      try { return { ...row, payload: JSON.parse(row.payload) }; } catch { return row; }
    }),
  };
}

// header 优先、query 兜底：DSH 插件用 header 传（不落 URL/访问日志的 query
// string），黑盒探针/手工调试用 query 也能测。两者都缺时返回空串，由调用方
// 统一判 400——不在这里就下判断，保持与 /agent-proposals 对 session_id 的校验
// 尺度一致（都在路由体里判断、都走同一套错误码）。
function sessionIdFromRequest(req) {
  const header = req.get('X-Anjian-Session-Id');
  if (typeof header === 'string' && header.trim()) return header.trim();
  const query = req.query?.session_id;
  if (typeof query === 'string' && query.trim()) return query.trim();
  return '';
}

r.get('/cases/byname/:name', (req, res) => {
  releaseDueSnoozes();
  const c = db.prepare('SELECT * FROM cases WHERE name = ?').get(req.params.name);
  if (!c) return res.status(404).json({ error: '案件不存在' });
  res.json(buildCaseView(c));
});

function directWriteError(res, error) {
  return res.status(error.status || (error.code === 'case_not_found' ? 404 : 400)).json({
    error: error.message,
    code: error.code || 'agent_direct_invalid',
  });
}

function runAgentDirectWrite({ kind, caseId, payload, actor, sessionId }) {
  let item;
  let created = true;
  let derived;
  if (kind === 'contact') {
    const result = upsertContactRecord({ caseId, payload, actor, createdBy: 'ai' });
    item = result.row;
    created = result.created;
  } else if (kind === 'task') {
    item = createTaskRecord({ caseId, payload, actor, origin: 'llm' });
  } else if (kind === 'event') {
    const result = createEventRecord({ caseId, payload, actor, createdBy: 'llm' });
    item = result.row;
    derived = result.derived;
  } else if (kind === 'fact') {
    item = createFactRecord({ caseId, payload, actor, createdBy: 'ai' });
  } else if (kind === 'deadline') {
    item = createDeadlineRecord({
      caseId,
      payload,
      actor,
      createdBy: 'ai',
      reviewStatus: 'pending_review',
    });
  } else {
    const error = new Error('agent 直写 kind 须为 contact/task/event/fact/deadline');
    error.code = 'agent_direct_kind_invalid';
    throw error;
  }
  audit(actor, 'agent-direct', kind, item.id, `session=${String(sessionId).slice(0, 200)}`);
  return { created, outcome: created ? 'created' : 'updated', kind, item, ...(derived ? { derived } : {}) };
}

// DSH agent 专用只读面：session_id 由 supervisor 固定注入 worker env，服务端按
// session-registry 反查绑定 case——与 /agent-proposals 同一条信任规则（body/
// header 里的 session_id 只是"查哪个 session"的钥匙，caseId 绝不来自请求方
// 自报的任何字段）。取代插件此前直接打 /internal/cases/byname/:name 的自由
// name 参数：DSH worker 天生单案，不该、也不需要能读到任意案件名下的数据。
r.get('/agent-case-view', (req, res) => {
  const sessionId = sessionIdFromRequest(req);
  if (!sessionId) return res.status(400).json({ error: '缺少 session_id', code: 'session_id_invalid' });
  const caseId = caseIdForSession(sessionId);
  if (!caseId) return res.status(403).json({ error: 'session 未绑定任何存活 case，拒绝读取', code: 'session_not_bound' });
  releaseDueSnoozes();
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!c) return res.status(404).json({ error: '案件不存在' });
  res.json(buildCaseView(c));
});

// DSH agent 专用 digest：同样按 session 反查绑定 case，buildDigest(caseId) 只
// 返回该案的分桶行，不像 /internal/digest 那样是全所口径——agent worker 不该
// 看到别的案件名字出现在 red/week/watch/hearings/……任何一个桶里。
r.get('/agent-digest', (req, res) => {
  const sessionId = sessionIdFromRequest(req);
  if (!sessionId) return res.status(400).json({ error: '缺少 session_id', code: 'session_id_invalid' });
  const caseId = caseIdForSession(sessionId);
  if (!caseId) return res.status(403).json({ error: 'session 未绑定任何存活 case，拒绝读取', code: 'session_not_bound' });
  res.json(buildDigest(caseId));
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

// DSH agent 统一写入口：mode=direct 时直写正式表；未带 mode 时仍是软建议，
// 始终只落 inbox task 卡、不直接创建 event/deadline。source 由服务端固定；
// case_id 绝不信任请求体，只按 session_id 反查
// session-registry.js 里 supervisor.start() 登记的绑定（设计稿 §2「case_id：
// 由 supervisor 的固定案件绑定产生，不从模型正文推断」/ §4「服务端从已存的
// session binding 取得 case/agent，不信任客户端提交的 case/cwd」）。
r.post('/agent-proposals', (req, res) => {
  const b = req.body || {};
  if (b.mode !== undefined && b.mode !== 'direct') {
    return res.status(400).json({ error: 'mode 非法', code: 'agent_mode_invalid' });
  }
  if (b.mode === 'direct') {
    if (!b.payload || typeof b.payload !== 'object' || Array.isArray(b.payload)) {
      return res.status(400).json({ error: 'payload 须为对象', code: 'agent_direct_payload_invalid' });
    }
    const sessionId = b.session_id;
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return res.status(400).json({ error: 'agent 直写必须携带 session_id', code: 'session_id_invalid' });
    }
    const caseId = caseIdForSession(sessionId);
    if (!caseId) {
      return res.status(403).json({ error: 'session 未绑定任何存活 case，拒绝直写', code: 'session_not_bound' });
    }
    try {
      const result = runAgentDirectWrite({
        kind: b.kind,
        caseId,
        payload: b.payload,
        actor: req.actor,
        sessionId,
      });
      return res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      return directWriteError(res, error);
    }
  }
  if (b.source !== undefined && b.source !== 'agent-propose') {
    return res.status(400).json({ error: 'source 由服务端固定为 agent-propose' });
  }
  if (!b.payload || typeof b.payload !== 'object' || Array.isArray(b.payload)) {
    return res.status(400).json({ error: 'payload 须为对象' });
  }
  const sessionId = b.session_id;
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return res.status(400).json({ error: 'agent-proposals 必须携带 session_id', code: 'session_id_invalid' });
  }
  // 反查而不是信任：body.case_id 从不参与本路由的任何判断，即使带了也直接
  // 丢弃——caseId 只可能来自 supervisor 登记表，查不到就是查不到。
  const caseId = caseIdForSession(sessionId);
  if (!caseId) {
    return res.status(403).json({ error: 'session 未绑定任何存活 case，拒绝提案', code: 'session_not_bound' });
  }
  try {
    const result = enqueueAgentProposal({
      caseId,
      proposalId: b.proposal_id,
      payload: b.payload,
      sourceRef: b.source_ref,
      // source_ref.session_id 落库前必须被这个反查用的权威 sessionId 覆盖
      // ——见 recommendations.js 里 boundSessionId 的注释：body.source_ref
      // 里的 session_id 是 worker 自报值，不可信。
      boundSessionId: sessionId,
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
