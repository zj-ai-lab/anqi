// anqi 领域工具（preset-owned，只在 dsh-agent 会话 scope 里可见）。
//
// 移植自 anqi-spike-dsh 的 plugins/dsh-anqi/index.js，三个工具名和白名单字段
// 保持不变：anqi_case_get / anqi_digest 原样（contacts 永不出现在返回里，见
// CASE_FIELDS 等白名单常量——铁律 9 防回归）。唯一改造的是 anqi_inbox_propose：
//
//   - 打的入口从 /internal/inbox 换成 /internal/agent-proposals（设计稿 §2：
//     agent 提案是任意条数的具体待办，不是 /internal/inbox 服务的「每案一条
//     下一步」周期检视——两者共用一个入口会把提案错误地去重成同一条，参见
//     spike REPORT.md §12.5 第 1 点的真实复现）。
//   - 不再从模型参数里读 case_name：案件绑定必须由 supervisor 产生、不能从
//     模型正文推断（设计稿 §2「case_id：由 supervisor 的固定案件绑定产生，
//     不从模型正文推断」）。本 worker 天生就是单案 worker（cwd 已经固定在
//     该案件夹），所以工具本身不需要案件参数；真正的 case 绑定由服务端在
//     /internal/agent-proposals 里按 supervisor 已登记的 session_id 反查得到
//     ——同一条原则见设计稿 §4「服务端从已存的 session binding 取得
//     case/agent，不信任客户端提交的 case/cwd」，approval 和 proposal 走的是
//     同一条信任规则。
//   - proposal_id 由本工具在每次 execute() 里生成一次（crypto.randomUUID()），
//     它是幂等主键：同一次工具调用内的 HTTP 重试复用同一个 proposal_id，不同
//     的工具调用即使 title 相同也各自成一条独立建议（设计稿 §2）。
//   - source_ref 只携带可审计的 session/call 关联 id，不携带完整案卷正文或
//     任何密钥。
//
// /internal/agent-proposals 本身在下一阶段实现；这里先把请求形状钉好。
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-anqi';
export const inject = ['tools'];

const CASE_FIELDS = [
  'id', 'name', 'case_no', 'cause', 'court', 'procedure', 'stage',
  'stage_entered_at', 'status', 'accepted_at',
];
const EVENT_FIELDS = [
  'id', 'type', 'occurred_on', 'service_method', 'instrument', 'note', 'created_by',
];
const DEADLINE_FIELDS = [
  'id', 'name', 'due_on', 'basis', 'calc_note', 'severity', 'status', 'done_at',
];
const TASK_FIELDS = [
  'id', 'title', 'plan_date', 'due_on', 'due_time', 'deadline_id', 'stage',
  'priority', 'origin', 'status', 'done_at', 'note',
];
const WORKLOG_FIELDS = ['id', 'worked_on', 'content', 'minutes', 'artifacts'];
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
    events: pickRows(value?.events, EVENT_FIELDS),
    deadlines: pickRows(value?.deadlines, DEADLINE_FIELDS),
    tasks: pickRows(value?.tasks, TASK_FIELDS),
    tasks_recent_closed: pickRows(value?.tasks_recent_closed, TASK_FIELDS),
    worklog_recent: pickRows(value?.worklog_recent, WORKLOG_FIELDS),
    recommendations_recent: recommendations,
  };
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

// supervisor 在 spawn 时按 worker 固定注入（见 supervisor.js buildSanitizedEnv）；
// 不是模型可控的输入。缺失时说明不是由本仓库 supervisor 拉起，直接拒绝启动。
function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`dsh-anqi requires ${name} to be set by the supervisor`);
  return value;
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

  async function request(pathname, { method = 'GET', body, signal } = {}) {
    const internalKey = process.env[internalKeyEnv];
    if (!internalKey) throw new Error(`${internalKeyEnv} is not set`);

    const response = await fetch(new URL(pathname, baseURL), {
      method,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      headers: {
        'X-Anjian-Key': internalKey,
        'X-Anjian-Actor': 'dsh-agent',
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

  ctx.tools.register(defineTool({
    name: 'anqi_case_get',
    description: 'Read the whitelisted case facts, events, deterministic deadlines, tasks, worklog, and recent recommendations for one exact anqi case name. No contacts are returned.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Exact anqi case name.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          case: { ...OPEN_OBJECT, required: true },
          events: OBJECT_ARRAY,
          deadlines: OBJECT_ARRAY,
          tasks: OBJECT_ARRAY,
          tasks_recent_closed: OBJECT_ARRAY,
          worklog_recent: OBJECT_ARRAY,
          recommendations_recent: OBJECT_ARRAY,
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const caseName = String(args.name || '').trim();
      if (!caseName) throw new Error('case name is required');
      const value = await request(`/internal/cases/byname/${encodeURIComponent(caseName)}`, {
        signal: exec.signal,
      });
      return sanitizeCasePayload(value);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'anqi_digest',
    description: 'Read the whitelisted anqi digest, including near deadlines, hearings, open tasks, fees due, and summary counts.',
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
      return sanitizeDigest(await request('/internal/digest', { signal: exec.signal }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'anqi_inbox_propose',
    description: 'Submit one task-only suggestion for lawyer review. This cannot create events or deadlines and never writes a task directly; it is only a proposal, not an approval.',
    parameters: {
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
}
