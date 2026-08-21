// enqueueAgentProposal() 单元冒烟：proposal_id 幂等 retry、同 title 异 proposal_id 并存、
// decline 记忆只属于该 proposal_id（不因案件状态变化重开）、与既有 L2 case.next_action
// 去重状态机互不覆盖——这四条正是设计稿 §2 与 spike REPORT §9 记录的 L2 去重误吞 agent
// 提案 bug 的验收点。另外覆盖修复轮的几个契约点：proposal_id 必须是字符串（不接受
// object/array 静默塌缩）、payload 字段名与 enqueueLlmSuggestion 对齐（title/priority/
// basis）、source_ref 必备且字段名对齐 DSH 插件实际形状（session_id/call_id/root_call_id）、
// coalesced 分支返回 touch 之后的新鲜行、source_ref.session_id 必须被服务端反查用的权威
// boundSessionId 覆盖（不采信 worker 自报值，防审计字段被伪造）。
//
// DB_PATH 隔离到临时文件：db.js 的 DB_PATH 在模块首次执行时读一次 process.env，必须在
// 任何静态 import 触发它加载之前设置好，所以延后到动态 import（与 tools/test-agent-config.js
// 同一套写法）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-agent-proposals-'));
process.env.DB_PATH = path.join(scratch, 'agent-proposals.db');

const { db } = await import('../src/db.js');
const { enqueueAgentProposal, enqueueLlmSuggestion } = await import('../src/lib/recommendations.js');

const caseId = db.prepare(
  "INSERT INTO cases (name, procedure, stage) VALUES ('张三诉李四合同纠纷（agent 提案测试）','一审','审理中')"
).run().lastInsertRowid;

function inboxRow(id) {
  return db.prepare('SELECT * FROM inbox WHERE id=?').get(id);
}

const ref = (callId) => ({ session_id: 'sess-1', call_id: callId, root_call_id: 'root-1' });
// 生产环境下这是路由层反查 caseIdForSession(session_id) 时用到的权威值；
// 这里的单元测试直接调 lib 函数、绕过路由，所以显式模拟同一个值。
const BOUND_SESSION_ID = 'sess-1';

// ---- 用例 1：proposal_id 幂等 retry ----
// 同一 proposal_id 重试必须命中同一行，不重复插入，且不刷新 payload；命中的行
// 必须是 touch 之后的新鲜快照（seen_count 已自增），不是陈旧行。
const first = enqueueAgentProposal({
  caseId,
  proposalId: 'prop-001',
  payload: { title: '核对送达回证', basis: '首次提案证据摘要 A' },
  sourceRef: ref('call-1'),
  boundSessionId: BOUND_SESSION_ID,
}, 'test');
assert.equal(first.created, true, '首次提案应新建');
assert.equal(inboxRow(first.item_id).source, 'agent-propose');
assert.equal(inboxRow(first.item_id).intent_key, 'v1:agent-proposal');
assert.equal(inboxRow(first.item_id).state_fingerprint, 'prop-001');
assert.equal(inboxRow(first.item_id).seen_count, 1);

const retry = enqueueAgentProposal({
  caseId,
  proposalId: 'prop-001',
  payload: { title: '核对送达回证（重试时模型换了措辞）', basis: '重试提案证据摘要 B' },
  sourceRef: ref('call-2'),
  boundSessionId: BOUND_SESSION_ID,
}, 'test');
assert.equal(retry.created, false, 'retry 不应新建');
assert.equal(retry.item_id, first.item_id, 'retry 必须命中同一行');
assert.equal(retry.item.seen_count, 2, 'coalesced 分支必须返回 touch 之后的新鲜行，不是陈旧快照');
assert.equal(
  db.prepare("SELECT COUNT(*) c FROM inbox WHERE source='agent-propose'").get().c,
  1,
  '同一 proposal_id 不应重复插入'
);
const afterRetryPayload = JSON.parse(inboxRow(first.item_id).payload);
assert.equal(afterRetryPayload.basis, '首次提案证据摘要 A', 'retry 不应刷新已存的 payload');

// ---- 用例 2：同 title 不同 proposal_id 各自建行，互不吞并 ----
const secondSameTitle = enqueueAgentProposal({
  caseId,
  proposalId: 'prop-002',
  payload: { title: '核对送达回证' },
  sourceRef: ref('call-3'),
  boundSessionId: BOUND_SESSION_ID,
}, 'test');
assert.equal(secondSameTitle.created, true, '不同 proposal_id 即使标题相同也必须新建');
assert.notEqual(secondSameTitle.item_id, first.item_id);
assert.equal(
  db.prepare("SELECT COUNT(*) c FROM inbox WHERE source='agent-propose' AND case_id=?").get(caseId).c,
  2,
  '两个不同 proposal_id 应各自持有一行'
);

// ---- 用例 3：decline 记忆只属于该 proposal_id，且不因“重新提交”重开 ----
db.prepare(
  `UPDATE inbox SET status='declined',decision_reason='律师选择不再建议',decided_at=datetime('now','+8 hours')
     WHERE id=?`
).run(secondSameTitle.item_id);
const afterDecline = enqueueAgentProposal({
  caseId,
  proposalId: 'prop-002',
  payload: { title: '核对送达回证' },
  sourceRef: ref('call-4'),
  boundSessionId: BOUND_SESSION_ID,
}, 'test');
assert.equal(afterDecline.created, false, 'declined 后同 proposal_id 重试不应重开');
assert.equal(afterDecline.item_id, secondSameTitle.item_id);
assert.equal(inboxRow(afterDecline.item_id).status, 'declined', 'decline 状态必须原样保留，不被重新打开');
// 新事实必须由新 proposal_id 表示：换一个 proposal_id 才能重新出现在待裁决列表。
const thirdNewProposal = enqueueAgentProposal({
  caseId,
  proposalId: 'prop-003',
  payload: { title: '核对送达回证' },
  sourceRef: ref('call-5'),
  boundSessionId: BOUND_SESSION_ID,
}, 'test');
assert.equal(thirdNewProposal.created, true);
assert.equal(inboxRow(thirdNewProposal.item_id).status, 'pending');

// ---- 用例 4：与既有 L2 case.next_action 去重状态机互不覆盖 ----
// llm-suggest 与 agent-propose 各自的 source 隔离在唯一索引里；同一案件下两条状态机
// 各自独立计数、互不覆盖对方的行。
const llmSuggestion = enqueueLlmSuggestion({
  caseId,
  payload: { title: '核对送达回证', priority: 'normal', basis: 'L2 自动建议' },
  recommendation: { intent: 'case.next_action' },
}, 'test');
assert.equal(llmSuggestion.created, true, 'llm-suggest 与 agent-propose 是不同 source，应各自建行');
assert.equal(
  db.prepare("SELECT COUNT(*) c FROM inbox WHERE source='llm-suggest' AND case_id=?").get(caseId).c,
  1
);
assert.equal(
  db.prepare("SELECT COUNT(*) c FROM inbox WHERE source='agent-propose' AND case_id=?").get(caseId).c,
  3,
  'llm-suggest 的新写入不应影响 agent-propose 已有的三行'
);
for (const id of [first.item_id, secondSameTitle.item_id, thirdNewProposal.item_id]) {
  assert.equal(inboxRow(id).intent_key, 'v1:agent-proposal', 'agent-propose 行的 intent_key 不应被 L2 覆盖');
}
// 反过来：agent-propose 的重试也不应影响 llm-suggest 那一行的状态。
enqueueAgentProposal({ caseId, proposalId: 'prop-001', payload: { title: '核对送达回证' }, sourceRef: ref('call-6'), boundSessionId: BOUND_SESSION_ID }, 'test');
assert.equal(inboxRow(llmSuggestion.item_id).source, 'llm-suggest');
assert.equal(inboxRow(llmSuggestion.item_id).status, 'pending');

// ---- 用例 5：source_ref.session_id 必须被服务端权威值覆盖，不采信 body 自报值 ----
// 审查发现：worker 可能（被 prompt 注入或写错）在 source_ref.session_id 里填一个
// 别的 session；案件归属靠 caseId 反查守住了，但审计字段本身如果照抄 body，
// 就等于强制存了一个不可信的值。这里故意让 sourceRef.session_id 与
// boundSessionId 不一致，断言落库的是后者。
const spoofedRefProposal = enqueueAgentProposal({
  caseId,
  proposalId: 'prop-spoofed-session',
  payload: { title: '核对送达回证' },
  sourceRef: { session_id: 'attacker-claimed-session', call_id: 'call-7', root_call_id: 'root-1' },
  boundSessionId: BOUND_SESSION_ID,
}, 'test');
assert.equal(spoofedRefProposal.created, true);
const storedRef = JSON.parse(inboxRow(spoofedRefProposal.item_id).source_ref);
assert.equal(storedRef.session_id, BOUND_SESSION_ID, 'source_ref.session_id 必须是服务端反查用的权威值，不是 body 自报的伪造值');
assert.notEqual(storedRef.session_id, 'attacker-claimed-session', 'body 里伪造的 session_id 不应该原样落库');
assert.equal(storedRef.call_id, 'call-7', 'call_id/root_call_id 仍然是模型自报值，不受影响');

// 服务端反查得不到绑定 sessionId 时（理论上路由层已经先 403 挡住，这里是 lib
// 层自身的防御性校验）必须拒绝，不能默默放行成无 boundSessionId 的提案。
assert.throws(
  () => enqueueAgentProposal({
    caseId, proposalId: 'prop-no-bound-session', payload: { title: 'x' }, sourceRef: ref('c'),
  }, 'test'),
  /服务端绑定的 session_id/,
  '缺少 boundSessionId 必须被拒绝'
);

// ---- 附加校验：非法输入必须拒绝（供 route 层复用的契约） ----
assert.throws(
  () => enqueueAgentProposal({ caseId, proposalId: '', payload: { title: 'x' }, sourceRef: ref('c') }, 'test'),
  /proposal_id/
);
assert.throws(
  () => enqueueAgentProposal({ caseId, proposalId: { a: 1 }, payload: { title: 'x' }, sourceRef: ref('c') }, 'test'),
  /proposal_id 必须为字符串/,
  'proposal_id 非字符串必须直接拒绝，不能被 String() 静默塌缩成幂等主键'
);
assert.throws(
  () => enqueueAgentProposal({ caseId, proposalId: ['x'], payload: { title: 'x' }, sourceRef: ref('c') }, 'test'),
  /proposal_id 必须为字符串/
);
assert.throws(
  () => enqueueAgentProposal({ caseId, proposalId: 'p', payload: { title: '' }, sourceRef: ref('c') }, 'test'),
  /title/
);
assert.throws(
  () => enqueueAgentProposal({ caseId, proposalId: 'p', payload: { title: 'x', kind: 'event' }, sourceRef: ref('c') }, 'test'),
  /不允许字段/
);
assert.throws(
  () => enqueueAgentProposal({ caseId: 999999, proposalId: 'p', payload: { title: 'x' }, sourceRef: ref('c') }, 'test'),
  /案件不存在/
);
// source_ref 是必备字段（设计稿 §2），缺失必须拒绝，不能默认放行成无审计关联的提案。
assert.throws(
  () => enqueueAgentProposal({ caseId, proposalId: 'p-no-ref', payload: { title: 'x' } }, 'test'),
  /source_ref/
);
assert.throws(
  () => enqueueAgentProposal({
    caseId, proposalId: 'p-bad-ref', payload: { title: 'x' },
    sourceRef: { session: 'sess-1', turn: '1', toolCallId: 'call-1' },
  }, 'test'),
  /不允许字段/,
  'source_ref 字段名必须是 session_id/call_id/root_call_id，旧字段名必须被拒绝'
);

fs.rmSync(scratch, { recursive: true, force: true });
console.log('agent proposals tests: 幂等 retry(新鲜快照) + 同题异 ID 并存 + decline 记忆 + 与 L2 互不覆盖 + proposal_id/source_ref 强校验 + session_id 服务端覆盖 passed');
