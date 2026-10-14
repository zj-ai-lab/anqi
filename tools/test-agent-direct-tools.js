// dsh-anqi 直写工具契约：案件面五类记录加工作日志，描述明确、session 固定注入、绝不携带 case_id。
import assert from 'node:assert/strict';
import { eventTypeGroups, eventTypes, isEventType } from '../src/lib/vocab.js';

process.env.ANJIAN_INTERNAL_KEY = 'direct-tools-test-key';
process.env.ANQI_AGENT_SESSION_ID = 'direct-tools-test-session';
// supervisor buildSpawnEnv 注入的同一份序列化（见 test-agent-supervisor.js 场景 29）。
process.env.DSH_ANQI_EVENT_TYPES = JSON.stringify(eventTypeGroups);

// anqi_event_add.type 必须把服务端词表原样摆给模型：enum = vocab 全部 id（同序），说明里逐条有 id=中文。
function assertEventTypeSchema(tool, scopeLabel) {
  const typeSchema = tool.parameters.properties.type;
  assert.ok(tool.parameters.required.includes('type'), `${scopeLabel} anqi_event_add.type 必填`);
  assert.deepEqual(eventTypeGroups.flatMap((group) => group.types), eventTypes, 'eventTypeGroups 必须与 eventTypes 同源同序');
  assert.deepEqual(typeSchema.enum, eventTypes.map((type) => type.id), `${scopeLabel} type.enum 必须等于 vocab 全部事件 id`);
  assert.ok(typeSchema.enum.every(isEventType), `${scopeLabel} type.enum 每项都必须过服务端 isEventType`);
  for (const { id, label } of eventTypes) {
    assert.ok(typeSchema.description.includes(`${id}=${label}`), `${scopeLabel} type 说明缺少 ${id}=${label}`);
  }
  for (const { group } of eventTypeGroups) {
    assert.ok(typeSchema.description.includes(`${group}：`), `${scopeLabel} type 说明缺少分组 ${group}`);
  }
  assert.match(typeSchema.description, /只能填下列 id 之一/);
  assert.match(typeSchema.description, /不要自造 id/);
}

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
    'anqi_worklog_add',
    'anqi_case_get',
    'anqi_digest',
    'anqi_inbox_propose',
    'anqi_contact_upsert',
    'anqi_task_add',
    'anqi_event_add',
    'anqi_fact_add',
    'anqi_deadline_add',
  ]);

  const directNames = ['anqi_worklog_add', 'anqi_contact_upsert', 'anqi_task_add', 'anqi_event_add', 'anqi_fact_add', 'anqi_deadline_add'];
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

  await byName.get('anqi_worklog_add').execute({ content: '完成会见记录', worked_on: '2030-01-01' }, exec);
  await byName.get('anqi_contact_upsert').execute({ role: '法官助理', name: '王助理', created_by: 'manual' }, exec);
  await byName.get('anqi_task_add').execute({ title: '核对送达', origin: 'manual' }, exec);
  await byName.get('anqi_event_add').execute({ type: 'other', occurred_on: '2030-01-01', created_by: 'manual' }, exec);
  await byName.get('anqi_fact_add').execute({ content: '法院通知补证', created_by: 'manual' }, exec);
  await byName.get('anqi_deadline_add').execute({ name: '补证期限', due_on: '2030-01-02', review_status: 'confirmed' }, exec);

  const directCalls = calls.filter((call) => call.body?.mode === 'direct');
  assert.deepEqual(directCalls.map((call) => call.body.kind), ['worklog', 'contact', 'task', 'event', 'fact', 'deadline']);
  for (const call of directCalls) {
    assert.equal(call.url.endsWith('/internal/agent-proposals'), true);
    assert.equal(call.body.session_id, process.env.ANQI_AGENT_SESSION_ID);
    assert.equal(Object.hasOwn(call.body, 'case_id'), false, '插件请求体不得提供模型可控 case_id');
    assert.equal(Object.hasOwn(call.body.payload, 'created_by'), false, '来源戳必须由服务端覆盖');
    assert.equal(Object.hasOwn(call.body.payload, 'review_status'), false, 'deadline 待核状态必须由服务端覆盖');
    assert.equal(call.options.headers['X-Anjian-Key'], process.env.ANJIAN_INTERNAL_KEY);
  }
  // 事件类型：schema 带全量枚举；词表外的值（含模型常猜的英文/中文写法）在发请求前就被 DSH 参数校验拒绝。
  assertEventTypeSchema(byName.get('anqi_event_add'), 'case');
  const invalidTypeMark = calls.length;
  for (const bad of ['judgment_received', 'receive_judgment', '收到判决', 'JUDGMENT_SERVED', '']) {
    await assert.rejects(
      byName.get('anqi_event_add').execute({ type: bad, occurred_on: '2030-01-01' }, exec),
      /"type" must be one of/,
      `type=${JSON.stringify(bad)} 必须在调用前被拒绝`,
    );
  }
  assert.equal(calls.length, invalidTypeMark, '非法 type 不得发出任何 HTTP 请求');
  await byName.get('anqi_event_add').execute({ type: 'judgment_served', occurred_on: '2030-01-01', note: '测试人民法院' }, exec);
  assert.equal(calls.at(-1).body.payload.type, 'judgment_served', '词表内 type 原样透传给服务端');

  console.log(`EVIDENCE_TOOL_NAMES ${JSON.stringify(tools.map((tool) => tool.name))}`);
  console.log(`EVIDENCE_PLUGIN_CASE_GET ${JSON.stringify({ contacts: caseView.contacts, facts: caseView.facts })}`);
  console.log('agent direct tools: worklog + visible contacts/facts + server-forced session/source/review contract passed');

  // ---- global scope（DSH_ANQI_SCOPE=global）：工具集、case_id 提前失败、resolve 白名单 ----
  const previousScope = process.env.DSH_ANQI_SCOPE;
  const caseScopeFetch = globalThis.fetch;
  try {
    process.env.DSH_ANQI_SCOPE = 'global';
    const globalTools = [];
    apply({ tools: { register(tool) { globalTools.push(tool); } } }, { baseURL: 'http://127.0.0.1:3007' });
    const globalByName = new Map(globalTools.map((tool) => [tool.name, tool]));
    assert.deepEqual([...globalByName.keys()].sort(), [
      'anqi_case_resolve', 'anqi_case_select', 'anqi_case_get', 'anqi_worklog_add', 'anqi_inbox_propose',
      'anqi_contact_upsert', 'anqi_task_add', 'anqi_event_add', 'anqi_fact_add', 'anqi_deadline_add',
    ].sort());
    assert.equal(globalTools.length, 10, '工具名不得重复注册');
    assert.equal(globalByName.has('anqi_digest'), false, 'global scope 不得有 anqi_digest');

    // resolve 响应带多余字段：插件必须只透出白名单键。
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).endsWith('/internal/agent-case-resolve')) {
        calls.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : undefined });
        return new Response(JSON.stringify({
          match: 'unique',
          candidates: [{
            id: 7, name: '甲诉乙合同纠纷', case_no: '(2030)粤0304民初1号', client: '甲', opponent: '乙',
            court: '虚构区法院', handling_agency: '', case_type: '民事', procedure: '一审', stage: '立案',
            phone: '13800138000', id_no: '000000000000000000', note: '不应透传',
          }],
          inactive_hits: 0, conflict: false, granted_case_id: 7, today: '2030-01-02', weekday: '星期三', debug: { sql: 'drop' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return caseScopeFetch(url, options);
    };

    const gExec = { signal: new AbortController().signal, callId: 'call-g', rootCallId: 'root-g' };

    const before = calls.length;
    const resolved = await globalByName.get('anqi_case_resolve').execute({ parties: ['甲'] }, gExec);
    assert.equal(calls.length, before + 1);
    assert.deepEqual(Object.keys(resolved).sort(), ['candidates', 'conflict', 'granted_case_id', 'inactive_hits', 'match', 'today', 'weekday']);
    assert.equal(resolved.today, '2030-01-02'); assert.equal(resolved.weekday, '星期三');
    assert.deepEqual(Object.keys(resolved.candidates[0]).sort(), [
      'case_no', 'case_type', 'client', 'court', 'handling_agency', 'id', 'name', 'opponent', 'procedure', 'stage',
    ]);
    assert.equal(resolved.granted_case_id, 7);
    assert.equal(Object.hasOwn(resolved, 'debug'), false);
    assert.equal(JSON.stringify(resolved).includes('13800138000'), false);

    // 七个必须带 case_id 的工具：缺失 / 0 / 负数 / 小数 / NaN 一律在发请求前拒绝。
    const requiredArgs = {
      anqi_event_add: { type: 'other', occurred_on: '2030-01-01' },
      anqi_contact_upsert: { role: '法官助理', name: '王助理' },
      anqi_fact_add: { content: '法院通知补证' },
      anqi_deadline_add: { name: '补证期限', due_on: '2030-01-02' },
      anqi_inbox_propose: { title: '核对送达' },
      anqi_case_get: {},
      anqi_case_select: {},
    };
    const caseIdError = /case_id is required: use granted_case_id from anqi_case_resolve or anqi_case_select/;
    for (const [toolName, args] of Object.entries(requiredArgs)) {
      const tool = globalByName.get(toolName);
      assert.ok(tool, `${toolName} 必须注册`);
      for (const bad of [undefined, 0, -3, 1.5, Number.NaN, 'abc']) {
        const mark = calls.length;
        // 缺失 / 非 number 类型先被 defineTool 的参数校验拦下（ToolArgsError），
        // 0 / 负数 / 小数过得了类型校验，必须由插件自己抛统一错误；两者都不得发请求。
        const frameworkRejects = bad === undefined || typeof bad !== 'number' || Number.isNaN(bad);
        await assert.rejects(
          tool.execute(bad === undefined ? { ...args } : { ...args, case_id: bad }, gExec),
          frameworkRejects ? /case_id|invalid arguments/ : caseIdError,
          `${toolName} case_id=${String(bad)} 必须提前失败`,
        );
        assert.equal(calls.length, mark, `${toolName} case_id=${String(bad)} 不得发出任何 HTTP 请求`);
      }
    }

    // task / worklog：case_id 可省略（所务记录），给了就必须合法。
    for (const toolName of ['anqi_task_add', 'anqi_worklog_add']) {
      const tool = globalByName.get(toolName);
      const args = toolName === 'anqi_task_add' ? { title: '所务待办' } : { content: '所务日志' };

      let mark = calls.length;
      await tool.execute({ ...args }, gExec);
      assert.equal(calls.length, mark + 1, `${toolName} 省略 case_id 应正常请求`);
      assert.equal(Object.hasOwn(calls.at(-1).body.payload, 'case_id'), false, `${toolName} 省略时 payload 不得带 case_id`);
      assert.equal(Object.hasOwn(calls.at(-1).body, 'case_id'), false);

      mark = calls.length;
      await tool.execute({ ...args, case_id: 7 }, gExec);
      assert.equal(calls.length, mark + 1);
      assert.equal(calls.at(-1).body.payload.case_id, 7, `${toolName} 带 case_id 时 payload 必须携带`);

      for (const bad of [0, -1, 2.5, Number.NaN, 'abc']) {
        mark = calls.length;
        await assert.rejects(
          tool.execute({ ...args, case_id: bad }, gExec),
          typeof bad !== 'number' || Number.isNaN(bad) ? /case_id|invalid arguments/ : caseIdError,
        );
        assert.equal(calls.length, mark, `${toolName} 非法 case_id=${String(bad)} 不得发请求`);
      }
    }

    // 合法 case_id 仍能正常写入，且带进 payload。
    const goodMark = calls.length;
    await globalByName.get('anqi_fact_add').execute({ content: '法院通知补证', case_id: 7 }, gExec);
    assert.equal(calls.length, goodMark + 1);
    assert.equal(calls.at(-1).body.payload.case_id, 7);

    // 两个 scope 的 anqi_case_get 输出 schema 必须一致。
    assert.deepEqual(globalByName.get('anqi_case_get').output.schema, byName.get('anqi_case_get').output.schema);

    // global 面同样带全量事件枚举（与案件面逐字一致），非法 type 即使 case_id 合法也不发请求。
    assertEventTypeSchema(globalByName.get('anqi_event_add'), 'global');
    assert.deepEqual(globalByName.get('anqi_event_add').parameters.properties.type, byName.get('anqi_event_add').parameters.properties.type);
    const globalInvalidMark = calls.length;
    await assert.rejects(
      globalByName.get('anqi_event_add').execute({ case_id: 7, type: 'judgment_received', occurred_on: '2030-01-08' }, gExec),
      /"type" must be one of/,
    );
    assert.equal(calls.length, globalInvalidMark, 'global 非法 type 不得发请求');
    await globalByName.get('anqi_event_add').execute({ case_id: 7, type: 'judgment_served', occurred_on: '2030-01-08' }, gExec);
    assert.equal(calls.length, globalInvalidMark + 1);
    assert.deepEqual(
      [calls.at(-1).body.payload.case_id, calls.at(-1).body.payload.type],
      [7, 'judgment_served'],
    );
    console.log('agent direct tools: global scope tool set + early case_id failure + resolve whitelist passed');
  } finally {
    globalThis.fetch = caseScopeFetch;
    if (previousScope === undefined) delete process.env.DSH_ANQI_SCOPE;
    else process.env.DSH_ANQI_SCOPE = previousScope;
  }

  // 词表注入缺失/损坏：插件拒绝加载，不静默退回无枚举的自由字符串。
  const goodVocab = process.env.DSH_ANQI_EVENT_TYPES;
  try {
    for (const [label, value] of [
      ['缺失', undefined],
      ['非 JSON', 'not-json'],
      ['空数组', '[]'],
      ['组内无类型', JSON.stringify([{ group: '民事及通用', types: [] }])],
      ['非法 id', JSON.stringify([{ group: '民事及通用', types: [{ id: '收到判决', label: '收到判决' }] }])],
      ['缺 label', JSON.stringify([{ group: '民事及通用', types: [{ id: 'hearing' }] }])],
      ['重复 id', JSON.stringify([
        { group: '民事及通用', types: [{ id: 'hearing', label: '开庭' }] },
        { group: '刑事专用', types: [{ id: 'hearing', label: '开庭' }] },
      ])],
    ]) {
      if (value === undefined) delete process.env.DSH_ANQI_EVENT_TYPES;
      else process.env.DSH_ANQI_EVENT_TYPES = value;
      assert.throws(
        () => apply({ tools: { register() {} } }, { baseURL: 'http://127.0.0.1:3007' }),
        /DSH_ANQI_EVENT_TYPES/,
        `事件词表${label}时插件必须拒绝加载`,
      );
    }
  } finally {
    process.env.DSH_ANQI_EVENT_TYPES = goodVocab;
  }
  console.log('agent direct tools: anqi_event_add type enum = vocab (both scopes) + invalid type rejected before HTTP + vocab injection fail-closed passed');
} finally {
  globalThis.fetch = originalFetch;
}
