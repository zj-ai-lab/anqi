// L2 推荐反馈闭环：模型只选择固定意图和写文案；身份、状态指纹与去重全部由服务端决定。
import crypto from 'node:crypto';
import { db, audit, withImmediateTransaction } from '../db.js';
import { todayCN } from './dates.js';

const INTENTS = new Set([
  'case.next_action',
  'case.stale_followup',
  'case.deadline_review',
  'fee.collect',
  'task.follow_up',
]);

const CHANGE_LABEL = {
  case: '案件阶段/状态',
  events: '程序事件',
  deadlines: '期限',
  tasks: '待办',
  worklog: '工作记录',
  fees: '收费状态',
  fee: '收费节点',
  task: '待办状态',
};

const caseRow = db.prepare(
  'SELECT id,status,procedure,stage,stage_entered_at FROM cases WHERE id=?'
);
const eventsForCase = db.prepare(
  `SELECT id,type,occurred_on,service_method
     FROM events WHERE case_id=? ORDER BY occurred_on,id`
);
const deadlinesForCase = db.prepare(
  `SELECT id,name,due_on,status,severity,rule_id,trigger_event_id,is_manual_override
     FROM deadlines WHERE case_id=? ORDER BY due_on,id`
);
const tasksForCase = db.prepare(
  `SELECT id,title,plan_date,due_on,deadline_id,stage,priority,status,done_at
     FROM tasks WHERE case_id=? ORDER BY id DESC LIMIT 50`
);
const worklogForCase = db.prepare(
  `SELECT id,worked_on FROM worklog WHERE case_id=? ORDER BY worked_on DESC,id DESC LIMIT 10`
);
const feesForCase = db.prepare(
  `SELECT id,amount_fen,node,due_on,status,paid_on
     FROM fee_items WHERE case_id=? ORDER BY id`
);
const feeById = db.prepare(
  `SELECT id,case_id,amount_fen,node,due_on,status,paid_on FROM fee_items WHERE id=?`
);
const taskById = db.prepare(
  `SELECT id,case_id,title,plan_date,due_on,deadline_id,stage,priority,status,done_at
     FROM tasks WHERE id=?`
);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function stateSummary(value) {
  return {
    count: Array.isArray(value) ? value.length : value ? 1 : 0,
    fingerprint: hash(value),
  };
}

export function recommendationContentKey(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 240);
}

function fail(message, code = 'recommendation_invalid') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function markerFor(caseId, recommendation = {}) {
  const currentCase = caseRow.get(caseId);
  if (!currentCase) fail('案件不存在', 'case_not_found');

  const intent = String(recommendation.intent || '').trim();
  if (!INTENTS.has(intent)) fail(`recommendation.intent 非法：${intent || '空'}`);
  const rawSubject = recommendation.subject_id;
  const subjectId = rawSubject === undefined || rawSubject === null || rawSubject === ''
    ? null : Number(rawSubject);
  if (subjectId !== null && (!Number.isInteger(subjectId) || subjectId <= 0)) {
    fail('recommendation.subject_id 非法');
  }

  const caseMarker = {
    id: currentCase.id,
    status: currentCase.status,
    procedure: currentCase.procedure,
    stage: currentCase.stage,
    stage_entered_at: currentCase.stage_entered_at,
  };
  let state;
  if (intent === 'case.next_action') {
    if (subjectId !== null) fail('case.next_action 不接受 subject_id');
    state = {
      case: caseMarker,
      events: eventsForCase.all(caseId),
      deadlines: deadlinesForCase.all(caseId),
      tasks: tasksForCase.all(caseId),
      worklog: worklogForCase.all(caseId),
      fees: feesForCase.all(caseId),
    };
  } else if (intent === 'case.stale_followup') {
    if (subjectId !== null) fail('case.stale_followup 不接受 subject_id');
    state = {
      case: caseMarker,
      events: eventsForCase.all(caseId).slice(-1),
      worklog: worklogForCase.all(caseId).slice(0, 1),
    };
  } else if (intent === 'case.deadline_review') {
    if (subjectId !== null) fail('case.deadline_review 不接受 subject_id');
    state = {
      case: caseMarker,
      events: eventsForCase.all(caseId),
      deadlines: deadlinesForCase.all(caseId).filter((row) => row.status === 'pending'),
    };
  } else if (intent === 'fee.collect') {
    if (subjectId === null) fail('fee.collect 必须带 subject_id');
    const fee = feeById.get(subjectId);
    if (!fee || fee.case_id !== caseId) fail('收费节点不属于该案件', 'recommendation_subject_invalid');
    state = { case: caseMarker, fee };
  } else {
    if (subjectId === null) fail('task.follow_up 必须带 subject_id');
    const task = taskById.get(subjectId);
    if (!task || task.case_id !== caseId) fail('待办不属于该案件', 'recommendation_subject_invalid');
    state = { case: caseMarker, task };
  }

  const intentKey = `v1:${intent}${subjectId === null ? '' : `:${subjectId}`}`;
  return {
    intent,
    intentKey,
    // 完整状态只在内存中参与 hash；持久化层只保存不可逆的组件摘要。
    stateMarker: Object.fromEntries(
      Object.entries(state).map(([key, value]) => [key, stateSummary(value)])
    ),
    stateFingerprint: `v1:${hash(state)}`,
  };
}

function parseMarker(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function sanitizedStateMarker(value) {
  const marker = parseMarker(value);
  return Object.fromEntries(Object.entries(marker).map(([key, component]) => {
    const alreadySummary = component && typeof component === 'object' && !Array.isArray(component)
      && Number.isInteger(component.count) && typeof component.fingerprint === 'string'
      && Object.keys(component).every((field) => ['count', 'fingerprint'].includes(field));
    return [key, alreadySummary ? component : stateSummary(component)];
  }));
}

function changeSummary(previousMarker, currentMarker) {
  const before = parseMarker(previousMarker);
  const changed = Object.keys(currentMarker).filter(
    (key) => JSON.stringify(stable(before[key])) !== JSON.stringify(stable(currentMarker[key]))
  );
  const labels = changed.map((key) => CHANGE_LABEL[key] || key);
  return labels.length ? `检测到${labels.join('、')}已有变化，因此重新建议` : '案件实质状态已有变化，因此重新建议';
}

export function releaseDueSnoozes() {
  return db.prepare(
    `UPDATE inbox SET status='pending',snooze_until='',decision_reason=''
      WHERE status='snoozed' AND snooze_until<>'' AND snooze_until<=?`
  ).run(todayCN()).changes;
}

function touchInbox(row) {
  db.prepare(
    `UPDATE inbox SET seen_count=seen_count+1,last_seen_at=datetime('now','+8 hours') WHERE id=?`
  ).run(row.id);
}

function publicResult(row, outcome, reason = '') {
  return {
    created: false,
    outcome,
    reason,
    item_id: row?.id || null,
    item: row || null,
  };
}

export function enqueueLlmSuggestion({ payload, sourceRef = '', caseId, recommendation }, actor = 'internal') {
  const allowedPayload = new Set(['title', 'priority', 'basis']);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('task 建议 payload 非法');
  const hidden = Object.keys(payload).filter((key) => !allowedPayload.has(key));
  if (hidden.length) fail(`task 建议含不允许字段：${hidden.join(',')}`);
  const title = String(payload.title || '').trim();
  if (!title) fail('task 建议缺 title');
  const priority = payload.priority === undefined ? 'normal' : String(payload.priority);
  if (!['high', 'normal', 'low'].includes(priority)) fail('task 建议 priority 非法');
  if (payload.basis !== undefined && typeof payload.basis !== 'string') fail('task 建议 basis 非法');
  const cleanPayload = {
    title: title.slice(0, 500),
    priority,
    ...(payload.basis ? { basis: payload.basis.trim().slice(0, 1000) } : {}),
  };
  const contentKey = recommendationContentKey(title);
  // 兼容发布窗口内尚未更新的旧自动化 prompt；稳定服务端默认意图仍能防重复。
  const requested = recommendation && typeof recommendation === 'object'
    ? recommendation : { intent: 'case.next_action' };
  const spec = markerFor(caseId, requested);

  return withImmediateTransaction(() => {
    releaseDueSnoozes();
    const scope = ['llm-suggest', 'task', caseId, spec.intentKey];
    const active = db.prepare(
      `SELECT * FROM inbox
        WHERE source=? AND kind=? AND case_id=? AND intent_key=?
          AND status IN ('pending','snoozed')
        ORDER BY id DESC LIMIT 1`
    ).get(...scope);
    if (active) {
      if (active.state_fingerprint === spec.stateFingerprint) {
        touchInbox(active);
        audit(actor, 'inbox-coalesce', 'inbox', active.id, `${spec.intentKey}:${active.status}`);
        return publicResult(db.prepare('SELECT * FROM inbox WHERE id=?').get(active.id), 'coalesced', active.status);
      }

      // pending/snoozed 期间案件已变化：保留同一张卡，但刷新建议和非敏感状态摘要。
      // 若案件状态回到了已有历史裁决，则收起旧卡并沿用那次裁决，避免唯一键冲突。
      const remembered = db.prepare(
        `SELECT * FROM inbox
          WHERE source=? AND kind=? AND case_id=? AND intent_key=? AND state_fingerprint=? AND id<>?
          ORDER BY id DESC LIMIT 1`
      ).get(...scope, spec.stateFingerprint, active.id);
      if (remembered) {
        db.prepare(
          `UPDATE inbox SET status='declined',decision_reason='系统收起：当前状态已有历史裁决',
             snooze_until='',decided_at=datetime('now','+8 hours'),last_seen_at=datetime('now','+8 hours')
           WHERE id=? AND status IN ('pending','snoozed')`
        ).run(active.id);
        touchInbox(remembered);
        audit(actor, 'inbox-suppress', 'inbox', remembered.id, `${spec.intentKey}:remembered_state`);
        return publicResult(
          db.prepare('SELECT * FROM inbox WHERE id=?').get(remembered.id),
          'suppressed',
          remembered.status === 'declined' ? 'declined_same_state' : 'decided_same_state'
        );
      }
      const summary = active.state_fingerprint
        ? changeSummary(active.state_marker, spec.stateMarker)
        : '已按当前案件状态刷新建议';
      db.prepare(
        `UPDATE inbox SET payload=?,source_ref=?,content_key=?,state_fingerprint=?,state_marker=?,
           change_summary=?,seen_count=seen_count+1,last_seen_at=datetime('now','+8 hours')
         WHERE id=? AND status IN ('pending','snoozed')`
      ).run(
        JSON.stringify(cleanPayload), sourceRef, contentKey, spec.stateFingerprint,
        JSON.stringify(spec.stateMarker), summary, active.id
      );
      const refreshed = db.prepare('SELECT * FROM inbox WHERE id=?').get(active.id);
      audit(actor, 'inbox-refresh', 'inbox', active.id, `${spec.intentKey}:${active.status}`);
      return publicResult(refreshed, 'refreshed_after_state_change', active.status);
    }

    const acceptedOpen = db.prepare(
      `SELECT i.* FROM inbox i
        JOIN tasks t ON i.accepted_entity='task' AND t.id=i.accepted_entity_id
       WHERE i.source=? AND i.kind=? AND i.case_id=? AND i.intent_key=?
         AND i.status='accepted' AND t.status='open'
       ORDER BY i.id DESC LIMIT 1`
    ).get(...scope);
    if (acceptedOpen) {
      touchInbox(acceptedOpen);
      audit(actor, 'inbox-suppress', 'inbox', acceptedOpen.id, `${spec.intentKey}:accepted_open`);
      return publicResult(acceptedOpen, 'suppressed', 'accepted_open');
    }

    // 兼容 1.6 以前没有 accepted_entity 链接的已采纳建议：同名未结待办仍视为在办。
    const openTasks = db.prepare("SELECT id,title FROM tasks WHERE case_id=? AND status='open'").all(caseId);
    const sameOpenTask = openTasks.find((row) => recommendationContentKey(row.title) === contentKey);
    if (sameOpenTask) {
      const legacyAccepted = db.prepare(
        `SELECT * FROM inbox WHERE source='llm-suggest' AND kind='task' AND case_id=?
          AND status='accepted' AND content_key=? ORDER BY id DESC LIMIT 1`
      ).get(caseId, contentKey);
      if (legacyAccepted) {
        db.prepare(
          `UPDATE inbox SET accepted_entity='task',accepted_entity_id=? WHERE id=?`
        ).run(sameOpenTask.id, legacyAccepted.id);
        touchInbox(legacyAccepted);
        return publicResult(legacyAccepted, 'suppressed', 'accepted_open');
      }
    }

    const sameState = db.prepare(
      `SELECT * FROM inbox
        WHERE source=? AND kind=? AND case_id=? AND intent_key=? AND state_fingerprint=?
        ORDER BY id DESC LIMIT 1`
    ).get(...scope, spec.stateFingerprint);
    if (sameState) {
      touchInbox(sameState);
      const reason = sameState.status === 'declined' ? 'declined_same_state' : 'decided_same_state';
      audit(actor, 'inbox-suppress', 'inbox', sameState.id, `${spec.intentKey}:${reason}`);
      return publicResult(sameState, 'suppressed', reason);
    }

    // 旧版无可靠 intent/state：独立的 suppression 既不伪造历史指纹，也长期保留负反馈。
    const legacy = db.prepare(
      `SELECT s.*,i.* FROM llm_legacy_suppressions s JOIN inbox i ON i.id=s.source_inbox_id
        WHERE s.case_id=? AND (s.intent_key=? OR (s.content_key<>'' AND s.content_key=?))
        ORDER BY s.id DESC LIMIT 1`
    ).get(caseId, spec.intentKey, contentKey);
    if (legacy) {
      touchInbox(legacy);
      audit(actor, 'inbox-suppress', 'inbox', legacy.source_inbox_id, 'legacy_declined');
      return publicResult(
        db.prepare('SELECT * FROM inbox WHERE id=?').get(legacy.source_inbox_id),
        'suppressed',
        'legacy_declined'
      );
    }

    const previous = db.prepare(
      `SELECT * FROM inbox
        WHERE source=? AND kind=? AND case_id=? AND intent_key=?
          AND status IN ('accepted','declined')
        ORDER BY id DESC LIMIT 1`
    ).get(...scope);
    const summary = previous ? changeSummary(previous.state_marker, spec.stateMarker) : '';
    const info = db.prepare(
      `INSERT INTO inbox
        (kind,payload,source,source_ref,case_id,intent_key,content_key,state_fingerprint,state_marker,
         last_seen_at,supersedes_inbox_id,change_summary)
       VALUES ('task',?,'llm-suggest',?,?,?,?,?,?,datetime('now','+8 hours'),?,?)`
    ).run(
      JSON.stringify(cleanPayload), sourceRef, caseId, spec.intentKey, contentKey,
      spec.stateFingerprint, JSON.stringify(spec.stateMarker), previous?.id || null, summary
    );
    const row = db.prepare('SELECT * FROM inbox WHERE id=?').get(info.lastInsertRowid);
    const outcome = previous ? 'reproposed_after_state_change' : 'created';
    audit(actor, 'create', 'inbox', row.id, `llm-suggest:${spec.intentKey}:${outcome}`);
    return { created: true, outcome, reason: '', item_id: row.id, item: row };
  });
}

// DSH agent 提案闭环：与 enqueueLlmSuggestion() 并列、不共用状态机。
// intent_key 固定为 v1:agent-proposal；state_fingerprint 直接是 supervisor 派发的
// trusted proposal_id（不做 hash），因此 proposal_id 本身就是幂等主键：
//   - 同一 proposal_id 重试 → 命中同一行，原样返回（不刷新 payload、不因案件状态变化
//     重开/重新接受，accept/decline 记忆永远只属于这个 proposal_id）；
//   - 不同 proposal_id 即使标题相同也各自建行，互不吞并（content_key 只服务展示稳定性）。
// 这正是 spike 报告里 L2 去重（按状态指纹折叠）会误吞 agent 提案的修法：agent 提案的
// “状态”定义是提案本身的身份，不是案件当前状态。
export function enqueueAgentProposal({ caseId, proposalId, payload, sourceRef }, actor = 'internal') {
  const currentCase = caseRow.get(caseId);
  if (!currentCase) fail('案件不存在', 'case_not_found');

  const propId = String(proposalId || '').trim();
  if (!propId) fail('proposal_id 缺失或非法', 'proposal_invalid');
  if (propId.length > 200) fail('proposal_id 过长', 'proposal_invalid');

  const allowedPayload = new Set(['title', 'note', 'evidence']);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('agent 提案 payload 非法');
  const hidden = Object.keys(payload).filter((key) => !allowedPayload.has(key));
  if (hidden.length) fail(`agent 提案含不允许字段：${hidden.join(',')}`);
  const title = String(payload.title || '').trim();
  if (!title) fail('agent 提案缺 title');
  if (payload.note !== undefined && typeof payload.note !== 'string') fail('agent 提案 note 非法');
  if (payload.evidence !== undefined && typeof payload.evidence !== 'string') fail('agent 提案 evidence 非法');
  const cleanPayload = {
    title: title.slice(0, 500),
    ...(payload.note ? { note: payload.note.trim().slice(0, 1000) } : {}),
    ...(payload.evidence ? { evidence: payload.evidence.trim().slice(0, 1000) } : {}),
  };
  const contentKey = recommendationContentKey(title);

  // source_ref 只保留可审计的 session/turn/tool-call 关联标识，绝不夹带敏感案卷正文。
  let sourceRefText = '';
  if (sourceRef !== undefined && sourceRef !== null) {
    if (typeof sourceRef !== 'object' || Array.isArray(sourceRef)) fail('agent 提案 source_ref 非法');
    const allowedRef = ['session', 'turn', 'toolCallId'];
    const hiddenRef = Object.keys(sourceRef).filter((key) => !allowedRef.includes(key));
    if (hiddenRef.length) fail(`agent 提案 source_ref 含不允许字段：${hiddenRef.join(',')}`);
    const cleanRef = {};
    for (const key of allowedRef) {
      if (sourceRef[key] === undefined || sourceRef[key] === null) continue;
      if (typeof sourceRef[key] !== 'string' && typeof sourceRef[key] !== 'number') {
        fail(`agent 提案 source_ref.${key} 非法`);
      }
      cleanRef[key] = String(sourceRef[key]).slice(0, 200);
    }
    sourceRefText = JSON.stringify(cleanRef).slice(0, 1000);
  }

  const intentKey = 'v1:agent-proposal';
  const scope = ['agent-propose', 'task', caseId, intentKey, propId];

  return withImmediateTransaction(() => {
    releaseDueSnoozes();
    const existing = db.prepare(
      `SELECT * FROM inbox
        WHERE source=? AND kind=? AND case_id=? AND intent_key=? AND state_fingerprint=?
        ORDER BY id DESC LIMIT 1`
    ).get(...scope);
    if (existing) {
      touchInbox(existing);
      audit(actor, 'agent-proposal-retry', 'inbox', existing.id, `${intentKey}:${propId}:${existing.status}`);
      return publicResult(existing, 'coalesced', existing.status);
    }

    const info = db.prepare(
      `INSERT INTO inbox
        (kind,payload,source,source_ref,case_id,intent_key,content_key,state_fingerprint,last_seen_at)
       VALUES ('task',?,'agent-propose',?,?,?,?,?,datetime('now','+8 hours'))`
    ).run(JSON.stringify(cleanPayload), sourceRefText, caseId, intentKey, contentKey, propId);
    const row = db.prepare('SELECT * FROM inbox WHERE id=?').get(info.lastInsertRowid);
    audit(actor, 'create', 'inbox', row.id, `agent-propose:${propId}`);
    return { created: true, outcome: 'created', reason: '', item_id: row.id, item: row };
  });
}

// 1.6 线上既有 L2 行没有 intent/state。历史弃置进入独立长期 suppression，绝不
// 用部署时状态伪造裁决时 fingerprint；最近的未裁决/已采纳行只补 intent，待下次命中刷新。
export function backfillRecommendationMemory() {
  return withImmediateTransaction(() => {
    let changed = 0;
    const rows = db.prepare(
      `SELECT * FROM inbox WHERE source='llm-suggest' AND kind='task' ORDER BY case_id,id DESC`
    ).all();
    for (const row of rows) {
      const key = recommendationContentKey(parseMarker(row.payload).title);
      if (row.content_key !== key || !row.last_seen_at) {
        db.prepare(
          `UPDATE inbox SET content_key=?,last_seen_at=CASE WHEN last_seen_at='' THEN created_at ELSE last_seen_at END WHERE id=?`
        ).run(key, row.id);
        changed++;
      }
      const safeMarker = sanitizedStateMarker(row.state_marker);
      const safeMarkerJson = JSON.stringify(safeMarker);
      if (safeMarkerJson !== row.state_marker) {
        db.prepare('UPDATE inbox SET state_marker=? WHERE id=?').run(safeMarkerJson, row.id);
        changed++;
      }
      if (row.status === 'accepted' && !row.accepted_entity) {
        const log = db.prepare(
          `SELECT entity,entity_id FROM audit_log
            WHERE action='inbox-accept' AND detail LIKE ? ORDER BY id DESC LIMIT 1`
        ).get(`inbox #${row.id} (%`);
        if (log?.entity && log.entity_id) {
          db.prepare('UPDATE inbox SET accepted_entity=?,accepted_entity_id=? WHERE id=?')
            .run(log.entity, log.entity_id, row.id);
          changed++;
        }
      }
      if (row.case_id && row.status === 'declined' && !row.intent_key) {
        const inserted = db.prepare(
          `INSERT OR IGNORE INTO llm_legacy_suppressions
             (case_id,source_inbox_id,intent_key,content_key)
           VALUES (?,?,'v1:case.next_action',?)`
        ).run(row.case_id, row.id, key);
        changed += inserted.changes;
      }
    }

    const latestByCase = new Map();
    for (const row of rows) {
      if (row.case_id && row.status !== 'declined' && !row.intent_key && !latestByCase.has(row.case_id)) {
        latestByCase.set(row.case_id, row);
      }
    }
    for (const row of latestByCase.values()) {
      db.prepare("UPDATE inbox SET intent_key='v1:case.next_action' WHERE id=?").run(row.id);
      changed++;
    }
    if (changed) audit('system', 'recommendation-backfill', 'inbox', null, `${changed} fields`);
    return changed;
  });
}

export function recommendationIntents() {
  return [...INTENTS];
}
