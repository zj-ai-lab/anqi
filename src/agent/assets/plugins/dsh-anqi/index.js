// anqi 领域工具（preset-owned，只在 dsh-agent 会话 scope 里可见）。
//
// 移植自 anqi-spike-dsh 的 plugins/dsh-anqi/index.js，白名单字段常量
// 所有读写工具都走 session 绑定端点，不提供任何自由参数选择案件：
//
//   - anqi_case_get：不再接受模型可控的 `name` 参数，改打 /internal/
//     agent-case-view（无参数，服务端按 session_id 反查绑定 case）。此前的
//     形状（`name` 命中任意案件名）等于让模型可以读到当前案件之外任何一个
//     案件的全景——一个单案 worker 完全不需要这项能力，反而是越权读的现成
//     入口。
//   - anqi_digest：不再打全所口径的 /internal/digest（会把别的案件名字混
//     进 red/week/watch/hearings 等分桶），改打 /internal/agent-digest——
//     服务端按 session_id 反查绑定 case 后，只返回该案自己的分桶行。
//   - anqi_inbox_propose：入口是 /internal/agent-proposals（与 /internal/inbox
//     分开，不复用其语义、不混入 case.next_action——agent 提案是任意条数的
//     具体待办，不是 /internal/inbox 服务的「每案一条下一步」周期检视，两者
//     共用一个入口会把提案错误地去重成同一条，参见 spike REPORT.md §12.5
//     第 1 点的真实复现）。
//
// 三个工具共同的信任规则（设计稿 §2「case_id：由 supervisor 的固定案件绑定
// 产生，不从模型正文推断」/ §4「服务端从已存的 session binding 取得
// case/agent，不信任客户端提交的 case/cwd」）：案件绑定只能来自 supervisor
// 固定注入的 session_id，本插件从不在任何工具参数里暴露"选案件"的能力；真正
// 的 case 绑定由服务端在 /internal/agent-case-view、/internal/agent-digest、
// /internal/agent-proposals 三处一致地按 session_id 反查得到。
//
//   - anqi_inbox_propose 的 proposal_id 由本工具在每次 execute() 里生成一次
//     （crypto.randomUUID()），它是幂等主键：同一次工具调用内的 HTTP 重试复用
//     同一个 proposal_id，不同的工具调用即使 title 相同也各自成一条独立建议
//     （设计稿 §2）。
//   - source_ref 只携带可审计的 session/call 关联 id，不携带完整案卷正文或
//     任何密钥。
//
// 三个端点均已在 src/routes/internal.js 落地：agent-case-view/agent-digest
// 只认 header（`X-Anjian-Session-Id`，本插件的写法）或 query 里的 session_id，
// agent-proposals 的请求形状（session_id/proposal_id/source_ref/payload 四个
// 字段名）必须与那里的白名单逐字一致——两边一旦漂移，模型每次调工具都会拿到
// 400/403。
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-anqi';
export const inject = ['tools'];

const CASE_FIELDS = [
  'id', 'name', 'case_no', 'cause', 'court', 'procedure', 'stage',
  'stage_entered_at', 'status', 'accepted_at',
];
const CONTACT_FIELDS = ['id', 'role', 'name', 'phone', 'id_no', 'org', 'note', 'created_by'];
const FACT_FIELDS = ['id', 'content', 'occurred_on', 'source', 'note', 'created_by', 'created_at', 'updated_at'];
const EVENT_FIELDS = [
  'id', 'type', 'occurred_on', 'occurred_time', 'location', 'service_method', 'instrument', 'note', 'created_by',
];
const DEADLINE_FIELDS = [
  'id', 'name', 'due_on', 'basis', 'calc_note', 'severity', 'status', 'done_at',
  'review_status', 'created_by',
];
const TASK_FIELDS = [
  'id', 'title', 'plan_date', 'due_on', 'due_time', 'deadline_id', 'stage',
  'priority', 'origin', 'created_by', 'status', 'done_at', 'note',
];
const WORKLOG_FIELDS = ['id', 'worked_on', 'content', 'minutes', 'artifacts', 'created_by'];
const RECOMMENDATION_FIELDS = [
  'id', 'intent_key', 'status', 'decision_reason', 'change_summary',
  'seen_count', 'created_at', 'decided_at',
];
const DIGEST_ROW_FIELDS = [
  'id', 'case_id', 'case_name', 'name', 'due_on', 'basis', 'calc_note',
  'severity', 'status', 'days_left', 'type', 'occurred_on', 'instrument',
  'is_today', 'title', 'plan_date', 'due_time', 'deadline_id', 'stage',
  'priority', 'origin', 'label', 'amount', 'node', 'paid_on', 'direction',
  'counterpart', 'due_month', 'external_case', 'overdue', 'procedure',
  'review_status', 'created_by',
];

const OPEN_OBJECT = {
  type: 'object',
  additionalProperties: true,
  properties: {},
};
const OBJECT_ARRAY = {
  type: 'array',
  required: true,
  items: OPEN_OBJECT,
};

// 案件面与全局面的 anqi_case_get 共用同一份输出 schema。
const CASE_GET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    case: { ...OPEN_OBJECT, required: true },
    contacts: OBJECT_ARRAY,
    facts: OBJECT_ARRAY,
    events: OBJECT_ARRAY,
    deadlines: OBJECT_ARRAY,
    tasks: OBJECT_ARRAY,
    tasks_recent_closed: OBJECT_ARRAY,
    worklog_recent: OBJECT_ARRAY,
    recommendations_recent: OBJECT_ARRAY,
  },
};

const CASE_RESOLVE_CANDIDATE_FIELDS = [
  'id', 'name', 'case_no', 'client', 'opponent', 'court', 'handling_agency', 'case_type', 'procedure', 'stage',
];
const CASE_RESOLVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    match: { type: 'string', required: true },
    candidates: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'number' },
          name: { type: 'string' },
          case_no: { type: 'string' },
          client: { type: 'string' },
          opponent: { type: 'string' },
          court: { type: 'string' },
          handling_agency: { type: 'string' },
          case_type: { type: 'string' },
          procedure: { type: 'string' },
          stage: { type: 'string' },
        },
      },
    },
    inactive_hits: { type: 'number', required: true },
    conflict: { type: 'boolean', required: true },
    today: { type: 'string', required: true },
    weekday: { type: 'string', required: true },
    granted_case_id: { type: 'number' },
  },
};

const CASE_ID_REQUIRED_MESSAGE = 'case_id is required: use granted_case_id from anqi_case_resolve or anqi_case_select';

// global 面 case_id 必须是正整数；optional=true 时允许省略（所务记录），但给了就必须合法。
// 在发任何 HTTP 请求之前调用，避免把 NaN/0 发到服务端再靠 400 兜底。
function globalCaseId(args, { optional = false } = {}) {
  const raw = args?.case_id;
  if (optional && (raw === undefined || raw === null)) return undefined;
  const id = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(CASE_ID_REQUIRED_MESSAGE);
  return id;
}

function pick(row, fields) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return {};
  return Object.fromEntries(fields.flatMap((field) => (
    row[field] === undefined || row[field] === null ? [] : [[field, row[field]]]
  )));
}

function pickRows(rows, fields) {
  return Array.isArray(rows) ? rows.map((row) => pick(row, fields)) : [];
}

function sanitizeCasePayload(value) {
  const recommendations = pickRows(value?.recommendations_recent, RECOMMENDATION_FIELDS)
    .map((row, index) => ({
      ...row,
      payload: pick(value.recommendations_recent[index]?.payload, ['title', 'priority', 'basis']),
    }));
  return {
    case: pick(value?.case, CASE_FIELDS),
    contacts: pickRows(value?.contacts, CONTACT_FIELDS),
    facts: pickRows(value?.facts, FACT_FIELDS),
    events: pickRows(value?.events, EVENT_FIELDS),
    deadlines: pickRows(value?.deadlines, DEADLINE_FIELDS),
    tasks: pickRows(value?.tasks, TASK_FIELDS),
    tasks_recent_closed: pickRows(value?.tasks_recent_closed, TASK_FIELDS),
    worklog_recent: pickRows(value?.worklog_recent, WORKLOG_FIELDS),
    recommendations_recent: recommendations,
  };
}

function sanitizeDirectResult(value, fields) {
  return {
    created: value?.created === true,
    outcome: String(value?.outcome || ''),
    kind: String(value?.kind || ''),
    item: pick(value?.item, fields),
    case_id: value?.case_id === null || value?.case_id === undefined ? null : Number(value.case_id),
    case_name: value?.case_name === undefined ? '' : String(value.case_name),
    ...(value?.derived && typeof value.derived === 'object' ? { derived: value.derived } : {}),
  };
}

function directPayload(args, fields, limits = {}) {
  const out = {};
  for (const field of fields) {
    if (args?.[field] === undefined || args?.[field] === null) continue;
    if (field === 'id' || field === 'deadline_id') out[field] = Number(args[field]);
    else out[field] = String(args[field]).trim().slice(0, limits[field] || 5000);
  }
  return out;
}

function sanitizeDigest(value) {
  return {
    date: String(value?.date || ''),
    counts: pick(value?.counts, ['active_cases', 'inbox_pending', 'open_tasks', 'unpaid_fees']),
    red: pickRows(value?.red, DIGEST_ROW_FIELDS),
    week: pickRows(value?.week, DIGEST_ROW_FIELDS),
    watch: pickRows(value?.watch, DIGEST_ROW_FIELDS),
    no_deadline_cases: pickRows(value?.no_deadline_cases, DIGEST_ROW_FIELDS),
    hearings: pickRows(value?.hearings, DIGEST_ROW_FIELDS),
    today_tasks: pickRows(value?.today_tasks, DIGEST_ROW_FIELDS),
    week_tasks: pickRows(value?.week_tasks, DIGEST_ROW_FIELDS),
    all_tasks: pickRows(value?.all_tasks, DIGEST_ROW_FIELDS),
    fees_due: pickRows(value?.fees_due, DIGEST_ROW_FIELDS),
    shares_pending: pickRows(value?.shares_pending, DIGEST_ROW_FIELDS),
  };
}

function loopbackOrigin(raw) {
  const url = new URL(String(raw || 'http://127.0.0.1:3007'));
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = hostname === '::1' || (isIP(hostname) === 4 && hostname.split('.')[0] === '127');
  if (!loopback || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('dsh-anqi baseURL must be an HTTP(S) loopback address');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('dsh-anqi baseURL must contain only scheme, loopback host, and port');
  }
  return url.origin;
}

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

// supervisor 在 spawn 时按 worker 固定注入（见 supervisor.js buildSpawnEnv）；
// 不是模型可控的输入。缺失时说明不是由本仓库 supervisor 拉起，直接拒绝启动。
function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`dsh-anqi requires ${name} to be set by the supervisor`);
  return value;
}

// anqi_event_add.type 的合法值：supervisor 用服务端 src/lib/vocab.js 的 eventTypeGroups 序列化注入
// （见 supervisor.js buildSpawnEnv）。此前 type 只写「见词表」，模型读不到词表只能猜 id，服务端全拒后
// 退回建待办，程序事件和引擎派生期限都丢了。这里生成 enum（DSH 调用前即校验）+ 分组中文对照；
// 服务端 isEventType 校验原样保留。缺失或格式不对直接拒绝启动，不静默退回无枚举。
const EVENT_TYPE_ID = /^[a-z][a-z0-9_]*$/;

function eventTypeVocabulary() {
  const raw = requiredEnv('DSH_ANQI_EVENT_TYPES');
  const invalid = () => new Error('dsh-anqi DSH_ANQI_EVENT_TYPES must be a JSON array of {group, types:[{id,label}]}');
  let groups;
  try {
    groups = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!Array.isArray(groups) || groups.length === 0) throw invalid();
  const ids = [];
  const lines = groups.map((group) => {
    const name = typeof group?.group === 'string' ? group.group.trim() : '';
    if (!name || !Array.isArray(group.types) || group.types.length === 0) throw invalid();
    const pairs = group.types.map((type) => {
      const label = typeof type?.label === 'string' ? type.label.trim() : '';
      if (typeof type?.id !== 'string' || !EVENT_TYPE_ID.test(type.id) || !label || ids.includes(type.id)) throw invalid();
      ids.push(type.id);
      return `${type.id}=${label}`;
    });
    return `${name}：${pairs.join('；')}`;
  });
  const fallback = ids.includes('other') ? '都不贴切时用 other 并把原话写进 note，' : '';
  return {
    ids,
    description: '程序事件类型，只能填下列 id 之一（等号后为中文含义）。刑事、行政案件先在专用组里找，'
      + `找不到再用民事及通用组（开庭、收到判决等各程序共用）；${fallback}不要自造 id。\n${lines.join('\n')}`,
  };
}

export function apply(ctx, config = {}) {
  const baseURL = loopbackOrigin(config.baseURL);
  const internalKeyEnv = String(config.internalKeyEnv || 'ANJIAN_INTERNAL_KEY');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(internalKeyEnv)) {
    throw new Error('dsh-anqi internalKeyEnv must be an environment variable name');
  }
  // 惰性读取：session id 只在真正提交提案时才校验存在，避免 case_get/digest
  // 这两个只读工具在还没接好 supervisor session 注入的过渡期里也被拖累失败。
  const agentSessionIdEnv = String(config.sessionIdEnv || 'ANQI_AGENT_SESSION_ID');
  // 直接加载插件的既有离线单元测试没有宿主 env；按历史案件面默认。
  // supervisor/runtime 会显式注入 scope，preset 仍对缺失 scope fail-closed。
  const scope = String(process.env.DSH_ANQI_SCOPE || 'case').trim();
  if (!['case', 'global'].includes(scope)) throw new Error('dsh-anqi requires DSH_ANQI_SCOPE=case|global');
  const eventTypes = eventTypeVocabulary();

  async function request(pathname, { method = 'GET', body, signal, headers: extraHeaders } = {}) {
    const internalKey = process.env[internalKeyEnv];
    if (!internalKey) throw new Error(`${internalKeyEnv} is not set`);

    const response = await fetch(new URL(pathname, baseURL), {
      method,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      headers: {
        'X-Anjian-Key': internalKey,
        'X-Anjian-Actor': 'dsh-agent',
        ...(extraHeaders || {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let value;
    try {
      value = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`anqi returned non-JSON HTTP ${response.status}`);
    }
    if (!response.ok) {
      const message = typeof value?.error === 'string' ? value.error.slice(0, 500) : `HTTP ${response.status}`;
      throw new Error(`anqi request failed: ${message}`);
    }
    return value;
  }

  async function directWrite(kind, payload, exec, fields) {
    exec.signal.throwIfAborted();
    const sessionId = requiredEnv(agentSessionIdEnv);
    const value = await request('/internal/agent-proposals', {
      method: 'POST',
      signal: exec.signal,
      body: { mode: 'direct', kind, session_id: sessionId, payload },
    });
    return sanitizeDirectResult(value, fields);
  }

  const directOutput = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        created: { type: 'boolean', required: true },
        outcome: { type: 'string', required: true },
        kind: { type: 'string', required: true },
        item: { ...OPEN_OBJECT, required: true },
        case_id: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        case_name: { type: 'string', required: true },
        derived: OPEN_OBJECT,
      },
    },
    render: renderJson,
  };

  if (scope === 'global') {
    ctx.tools.register(defineTool({
      name: 'anqi_case_resolve',
      description: '按律师提供的当事人、案号或办案机关调用案齐本地匹配。只能使用服务端返回的 granted_case_id；不得猜案件。',
      parameters: {
        parties: { type: 'array', items: { type: 'string' } },
        case_name: { type: 'string' }, case_no: { type: 'string' }, agency: { type: 'string' },
      },
      output: { schema: CASE_RESOLVE_SCHEMA, render: renderJson },
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        const sessionId = requiredEnv(agentSessionIdEnv);
        const value = await request('/internal/agent-case-resolve', {
          method: 'POST', signal: exec.signal,
          body: { session_id: sessionId, parties: Array.isArray(args?.parties) ? args.parties.map((v) => String(v).slice(0, 200)) : [], case_name: String(args?.case_name || '').slice(0, 200), case_no: String(args?.case_no || '').slice(0, 200), agency: String(args?.agency || '').slice(0, 200) },
        });
        return {
          match: String(value?.match || 'none'), candidates: pickRows(value?.candidates, CASE_RESOLVE_CANDIDATE_FIELDS),
          inactive_hits: Number(value?.inactive_hits || 0), conflict: value?.conflict === true, today: String(value?.today || ''), weekday: String(value?.weekday || ''),
          ...(value?.granted_case_id === undefined ? {} : { granted_case_id: Number(value.granted_case_id) }),
        };
      },
    }));
    ctx.tools.register(defineTool({
      name: 'anqi_case_select',
      description: '从 anqi_case_resolve 刚返回的候选中选择案件；其它 case_id 会被服务端拒绝。',
      parameters: { case_id: { type: 'number', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { granted_case_id: { type: 'number', required: true } } }, render: renderJson },
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        const caseId = globalCaseId(args);
        const sessionId = requiredEnv(agentSessionIdEnv);
        const value = await request('/internal/agent-case-select', { method: 'POST', signal: exec.signal, body: { session_id: sessionId, case_id: caseId } });
        return { granted_case_id: Number(value.granted_case_id) };
      },
    }));
    ctx.tools.register(defineTool({
      name: 'anqi_case_get',
      description: '读取已由 anqi_case_resolve 或 anqi_case_select 授予的案件；其它案件不可见。',
      parameters: { case_id: { type: 'number', required: true } },
      output: { schema: CASE_GET_SCHEMA, render: renderJson },
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        const caseId = globalCaseId(args);
        const sessionId = requiredEnv(agentSessionIdEnv);
        const value = await request(`/internal/agent-case-view?case_id=${encodeURIComponent(caseId)}`, { signal: exec.signal, headers: { 'X-Anjian-Session-Id': sessionId } });
        return sanitizeCasePayload(value);
      },
    }));
  }

  const caseIdParameter = scope === 'global' ? { case_id: { type: 'number', description: '只能填写 anqi_case_resolve 返回的 granted_case_id 或 anqi_case_select 的结果。' } } : {};
  const requiredCaseIdParameter = scope === 'global' ? {
    case_id: { type: 'number', required: true, description: '只能填写 anqi_case_resolve 返回的 granted_case_id 或 anqi_case_select 的结果。' },
  } : {};
  ctx.tools.register(defineTool({
    name: 'anqi_worklog_add',
    description: scope === 'global' ? '直接写入并盖 AI 戳的工作日志；case_id 只能使用服务端刚授予的案件，否则可省略记为所务记录。' : '直接写入绑定案件的工作日志并盖 AI 戳，人可改可撤。',
    parameters: { ...caseIdParameter, content: { type: 'string', required: true }, worked_on: { type: 'string' } },
    output: directOutput,
    async execute(args, exec) {
      const payload = directPayload(args, ['content', 'worked_on'], { content: 5000, worked_on: 10 });
      if (scope === 'global') {
        const caseId = globalCaseId(args, { optional: true });
        if (caseId !== undefined) payload.case_id = caseId;
      }
      return directWrite('worklog', payload, exec, WORKLOG_FIELDS);
    },
  }));

  if (scope === 'case') ctx.tools.register(defineTool({
    name: 'anqi_case_get',
    description: 'Read whitelisted contacts, formal facts, events, deadlines, tasks, worklog, and recent recommendations for the one anqi case this session is bound to. No other case can be selected or read.',
    parameters: {},
    output: { schema: CASE_GET_SCHEMA, render: renderJson },
    async execute(_args, exec) {
      exec.signal.throwIfAborted();
      // 案件绑定不读模型参数：见文件头注释——session_id 由 supervisor 固定
      // 注入，服务端按自己登记的 session→case 绑定反查 case_id，本工具没有
      // 任何参数能选择读哪个案件。
      const sessionId = requiredEnv(agentSessionIdEnv);
      const value = await request('/internal/agent-case-view', {
        signal: exec.signal,
        headers: { 'X-Anjian-Session-Id': sessionId },
      });
      return sanitizeCasePayload(value);
    },
  }));

  if (scope === 'case') ctx.tools.register(defineTool({
    name: 'anqi_digest',
    description: 'Read the whitelisted anqi digest scoped to the one case this session is bound to, including near deadlines, hearings, open tasks, fees due, and summary counts. Other cases never appear in the result.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string', required: true },
          counts: { ...OPEN_OBJECT, required: true },
          red: OBJECT_ARRAY,
          week: OBJECT_ARRAY,
          watch: OBJECT_ARRAY,
          no_deadline_cases: OBJECT_ARRAY,
          hearings: OBJECT_ARRAY,
          today_tasks: OBJECT_ARRAY,
          week_tasks: OBJECT_ARRAY,
          all_tasks: OBJECT_ARRAY,
          fees_due: OBJECT_ARRAY,
          shares_pending: OBJECT_ARRAY,
        },
      },
      render: renderJson,
    },
    async execute(_args, exec) {
      exec.signal.throwIfAborted();
      const sessionId = requiredEnv(agentSessionIdEnv);
      const value = await request('/internal/agent-digest', {
        signal: exec.signal,
        headers: { 'X-Anjian-Session-Id': sessionId },
      });
      return sanitizeDigest(value);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'anqi_inbox_propose',
    description: 'Submit one task-only suggestion for lawyer review. Global scope must provide a case_id granted by the server.',
    parameters: {
      ...requiredCaseIdParameter,
      title: {
        type: 'string',
        required: true,
        description: 'Proposed task title.',
      },
      note: {
        type: 'string',
        description: 'Optional factual basis or context for the lawyer; stored as task suggestion basis.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          created: { type: 'boolean', required: true },
          outcome: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          item_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const globalId = scope === 'global' ? globalCaseId(args) : undefined;
      const title = String(args.title || '').trim();
      const note = String(args.note || '').trim();
      if (!title) throw new Error('title is required');

      // 案件绑定不读模型参数：session_id 由 supervisor 固定注入，服务端按自己
      // 登记的 session→case 绑定反查 case_id（设计稿 §2/§4），本工具不负责
      // 也不能够声明自己属于哪个案件。
      const sessionId = requiredEnv(agentSessionIdEnv);
      const proposalId = randomUUID();

      const value = await request('/internal/agent-proposals', {
        method: 'POST',
        signal: exec.signal,
        body: {
          session_id: sessionId,
          ...(scope === 'global' ? { case_id: globalId } : {}),
          proposal_id: proposalId,
          source_ref: {
            session_id: sessionId,
            call_id: exec.callId === undefined ? '' : String(exec.callId),
            root_call_id: exec.rootCallId === undefined ? '' : String(exec.rootCallId),
          },
          payload: {
            title: title.slice(0, 500),
            priority: 'normal',
            ...(note ? { basis: note.slice(0, 1000) } : {}),
          },
        },
      });
      return {
        created: value?.created === true,
        outcome: String(value?.outcome || ''),
        reason: String(value?.reason || ''),
        item_id: value?.item_id === undefined || value?.item_id === null ? '' : String(value.item_id),
        status: String(value?.item?.status || ''),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'anqi_contact_upsert',
    description: '直接写入案件联系人并盖 AI 戳，人可改可撤。Global scope 的 case_id 只能用服务端授予值。',
    parameters: {
      ...requiredCaseIdParameter,
      id: { type: 'number', description: 'Existing contact id to update; omit to create.' },
      role: { type: 'string', description: '当事人/对方当事人/承办法官/法官助理/书记员/对方律师/合作律师/其他。' },
      name: { type: 'string', description: 'Contact name; required when creating.' },
      phone: { type: 'string' },
      id_no: { type: 'string' },
      org: { type: 'string' },
      note: { type: 'string' },
    },
    output: directOutput,
    async execute(args, exec) {
      const payload = directPayload(
        args, ['id', 'role', 'name', 'phone', 'id_no', 'org', 'note'],
        { role: 50, name: 300, phone: 100, id_no: 100, org: 500, note: 3000 }
      );
      if (scope === 'global') payload.case_id = globalCaseId(args);
      return directWrite('contact', payload, exec, CONTACT_FIELDS);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'anqi_task_add',
    description: '直接写入待办并盖 AI 戳，人可改可撤。Global scope 的 case_id 只能用服务端授予值，可省略记为所务待办。',
    parameters: {
      ...caseIdParameter,
      title: { type: 'string', required: true },
      plan_date: { type: 'string', description: 'Optional YYYY-MM-DD planned start date.' },
      due_on: { type: 'string', description: 'Optional YYYY-MM-DD task due date; not a legal deadline.' },
      due_time: { type: 'string', description: 'Optional HH:MM; requires due_on.' },
      deadline_id: { type: 'number', description: 'Optional deadline id from the bound case.' },
      stage: { type: 'string' },
      priority: { type: 'string', description: 'high/normal/low.' },
      note: { type: 'string' },
    },
    output: directOutput,
    async execute(args, exec) {
      const payload = directPayload(
        args, ['title', 'plan_date', 'due_on', 'due_time', 'deadline_id', 'stage', 'priority', 'note'],
        { title: 500, plan_date: 10, due_on: 10, due_time: 5, stage: 200, priority: 20, note: 3000 }
      );
      if (scope === 'global') {
        const caseId = globalCaseId(args, { optional: true });
        if (caseId !== undefined) payload.case_id = caseId;
      }
      return directWrite('task', payload, exec, TASK_FIELDS);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'anqi_event_add',
    description: '直接写入已授予案件的程序事件并盖 AI 戳，人可改可撤；global scope 必须提供服务端授予的 case_id。',
    parameters: {
      ...requiredCaseIdParameter,
      type: { type: 'string', required: true, enum: eventTypes.ids, description: eventTypes.description },
      occurred_on: { type: 'string', required: true, description: 'YYYY-MM-DD.' },
      service_method: { type: 'string' },
      instrument: { type: 'string' },
      note: { type: 'string' },
      occurred_time: { type: 'string', description: 'Optional HH:MM for hearings.' },
      location: { type: 'string', description: 'Optional hearing location.' },
    },
    output: directOutput,
    async execute(args, exec) {
      const payload = directPayload(
        args, ['type', 'occurred_on', 'occurred_time', 'location', 'service_method', 'instrument', 'note'],
        { type: 100, occurred_on: 10, occurred_time: 5, location: 120, service_method: 200, instrument: 1000, note: 3000 }
      );
      if (scope === 'global') payload.case_id = globalCaseId(args);
      return directWrite('event', payload, exec, EVENT_FIELDS);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'anqi_fact_add',
    description: '直接写入已授予案件的正式事实并盖 AI 戳，人可改可撤；global scope 必须提供服务端授予的 case_id。',
    parameters: {
      ...requiredCaseIdParameter,
      content: { type: 'string', required: true },
      occurred_on: { type: 'string', description: 'Optional YYYY-MM-DD fact date.' },
      source: { type: 'string', description: 'Optional source/provenance label.' },
      note: { type: 'string' },
    },
    output: directOutput,
    async execute(args, exec) {
      const payload = directPayload(
        args, ['content', 'occurred_on', 'source', 'note'],
        { content: 5000, occurred_on: 10, source: 1000, note: 3000 }
      );
      if (scope === 'global') payload.case_id = globalCaseId(args);
      return directWrite('fact', payload, exec, FACT_FIELDS);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'anqi_deadline_add',
    description: '直接写入已授予案件的待核期限并盖 AI 戳，人可改可撤；不进入提醒或期限跑道；global scope 必须提供服务端授予的 case_id。',
    parameters: {
      ...requiredCaseIdParameter,
      name: { type: 'string', required: true },
      due_on: { type: 'string', required: true, description: 'YYYY-MM-DD. The model supplies a draft date; the server marks it pending review.' },
      basis: { type: 'string' },
      calc_note: { type: 'string' },
      severity: { type: 'string', description: 'critical/high/normal.' },
    },
    output: directOutput,
    async execute(args, exec) {
      const payload = directPayload(
        args, ['name', 'due_on', 'basis', 'calc_note', 'severity'],
        { name: 500, due_on: 10, basis: 3000, calc_note: 3000, severity: 20 }
      );
      if (scope === 'global') payload.case_id = globalCaseId(args);
      return directWrite('deadline', payload, exec, DEADLINE_FIELDS);
    },
  }));
}
