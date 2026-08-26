// dsh-anqi 直写工具契约：五工具存在、描述明确、session 固定注入、绝不携带 case_id。
import assert from 'node:assert/strict';

process.env.ANJIAN_INTERNAL_KEY = 'direct-tools-test-key';
process.env.ANQI_AGENT_SESSION_ID = 'direct-tools-test-session';

const calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : undefined;
  calls.push({ url: String(url), options, body });
  if (String(url).endsWith('/internal/agent-case-view')) {
    return new Response(JSON.stringify({
      case: { id: 1, name: '绑定案', client: '不应透传的案件字段' },
      contacts: [{ id: 2, role: '法官助理', name: '王助理', phone: '13800138000', created_by: 'ai', hidden: 'drop' }],
      facts: [{ id: 3, content: '已通知补证', created_by: 'ai', hidden: 'drop' }],
      events: [], deadlines: [], tasks: [], tasks_recent_closed: [], worklog_recent: [], recommendations_recent: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({
    created: true,
    outcome: 'created',
    kind: body.kind,
    item: { id: calls.length, ...body.payload, created_by: body.kind === 'task' || body.kind === 'event' ? 'llm' : 'ai', review_status: body.kind === 'deadline' ? 'pending_review' : undefined },
  }), { status: 201, headers: { 'Content-Type': 'application/json' } });
};

try {
  const { apply } = await import('../src/agent/assets/plugins/dsh-anqi/index.js');
  const tools = [];
  apply({ tools: { register(tool) { tools.push(tool); } } }, { baseURL: 'http://127.0.0.1:3007' });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(tools.map((tool) => tool.name), [
    'anqi_case_get',
    'anqi_digest',
    'anqi_inbox_propose',
    'anqi_contact_upsert',
    'anqi_task_add',
    'anqi_event_add',
    'anqi_fact_add',
    'anqi_deadline_add',
  ]);

  const directNames = ['anqi_contact_upsert', 'anqi_task_add', 'anqi_event_add', 'anqi_fact_add', 'anqi_deadline_add'];
  for (const name of directNames) {
    const description = byName.get(name)?.description || '';
    assert.match(description, /直接写入/);
    assert.match(description, /AI 戳/);
    assert.match(description, /人可改可撤/);
  }
  assert.match(byName.get('anqi_deadline_add').description, /待核/);
  assert.match(byName.get('anqi_deadline_add').description, /不进入提醒或期限跑道/);

  const exec = { signal: new AbortController().signal, callId: 'call-1', rootCallId: 'root-1' };
  const caseView = await byName.get('anqi_case_get').execute({}, exec);
  assert.deepEqual(caseView.case, {
    id: 1,
    name: '绑定案',
  });
  assert.deepEqual(caseView.contacts, [{
    id: 2,
    role: '法官助理',
    name: '王助理',
    phone: '13800138000',
    created_by: 'ai',
  }]);
  assert.deepEqual(caseView.facts, [{ id: 3, content: '已通知补证', created_by: 'ai' }]);

  await byName.get('anqi_contact_upsert').execute({ role: '法官助理', name: '王助理', created_by: 'manual' }, exec);
  await byName.get('anqi_task_add').execute({ title: '核对送达', origin: 'manual' }, exec);
  await byName.get('anqi_event_add').execute({ type: 'other', occurred_on: '2030-01-01', created_by: 'manual' }, exec);
  await byName.get('anqi_fact_add').execute({ content: '法院通知补证', created_by: 'manual' }, exec);
  await byName.get('anqi_deadline_add').execute({ name: '补证期限', due_on: '2030-01-02', review_status: 'confirmed' }, exec);

  const directCalls = calls.filter((call) => call.body?.mode === 'direct');
  assert.deepEqual(directCalls.map((call) => call.body.kind), ['contact', 'task', 'event', 'fact', 'deadline']);
  for (const call of directCalls) {
    assert.equal(call.url.endsWith('/internal/agent-proposals'), true);
    assert.equal(call.body.session_id, process.env.ANQI_AGENT_SESSION_ID);
    assert.equal(Object.hasOwn(call.body, 'case_id'), false, '插件请求体不得提供模型可控 case_id');
    assert.equal(Object.hasOwn(call.body.payload, 'created_by'), false, '来源戳必须由服务端覆盖');
    assert.equal(Object.hasOwn(call.body.payload, 'review_status'), false, 'deadline 待核状态必须由服务端覆盖');
    assert.equal(call.options.headers['X-Anjian-Key'], process.env.ANJIAN_INTERNAL_KEY);
  }
  console.log(`EVIDENCE_TOOL_NAMES ${JSON.stringify(tools.map((tool) => tool.name))}`);
  console.log(`EVIDENCE_PLUGIN_CASE_GET ${JSON.stringify({ contacts: caseView.contacts, facts: caseView.facts })}`);
  console.log('agent direct tools: exact 8-tool set + visible contacts/facts + server-forced session/source/review contract passed');
} finally {
  globalThis.fetch = originalFetch;
}
