// DSH sidecar 的 HTTP/SSE 面（设计稿 §4）：案件 assistant drawer 需要的全部
// 读/写通路都在这里；本文件自己不管理 worker 生命周期，全部转交
// AgentSupervisor（src/agent/supervisor.js）。
//
// 挂载方式是工厂函数 createAgentRouter(supervisor)，不是像其它路由那样直接
// `export default Router()`——server.js 需要持有同一个 supervisor 实例才能在
// 进程退出时调用 stopAll()（本文件与 server.js 共用它，而不是各自 new 一个）。
//
// 红线落地对照（设计稿 §4 + 任务书）：
//   - GET  /api/agent/status                       —— 只读；enabled=false 时
//     直接返回 status:'disabled'，不触碰任何 worker/credential。
//   - POST /api/cases/:id/agent/start               —— 先自己查一遍
//     loadAgentConfig()（disabled 直接 409 agent_disabled，不进
//     supervisor.start()），再转发 supervisor.start()；disabled/error 两种
//     失败态映射成明确的 4xx/5xx，不吞成 200——双保险而不是互相替代，
//     supervisor.start() 内部对"既存 live worker"分支同样会重新查配置（见
//     supervisor.js），不靠这一层单独兜底。
//   - POST /api/cases/:id/agent/prompt              —— 同样先查
//     loadAgentConfig()（disabled 直接 409），再做同步可见的门禁校验；不等待
//     整轮完成（见下方该路由内的注释），真正的进度/结果只经 SSE 下行。
//   - POST /api/cases/:id/agent/cancel              —— 先查 loadAgentConfig()
//     （disabled 直接 409），再转发 supervisor.cancelTurn()。
//   - GET  /api/cases/:id/agent/events              —— authenticated SSE；订阅
//     绑定在服务端已知的 caseId 上，不接受、不使用客户端传来的任何 session id
//     做过滤依据（设计稿 §4「不把浏览器传来的任意 session ID 当作权限依据」）；
//     disabled 时首帧直接下发 status:'disabled'，不建立 supervisor 订阅。
//   - POST /api/agent/interactions/:id/answer        —— 先查 loadAgentConfig()
//     （disabled 直接 409，且先于 findInteractionOwner()），再校验：
//     interactionId 是唯一入参，caseId/worker 完全由服务端反查
//     （findInteractionOwner），不信任、也不需要客户端提交 case_id/session_id；
//     approval 的 outcome 与 question 的 answer 都经过严格校验，非法/过期/
//     已消费/跨 session/worker 已退一律拒绝并审计（不含敏感值）。
//   - 上面这五个端点的 disabled 检查全部各自独立调用 loadAgentConfig()，不
//     依赖某个上游中间件把结果挂在 req 上——每个端点都必须能在完全孤立的情况
//     下 fail-closed（编排方人工验收发现的运行时缺口：此前只有 GET
//     /agent/status 与 SSE 首帧做了这一层短路，start/prompt/cancel/answer
//     要么完全没查、要么只在 supervisor 内部间接查，见
//     docs/agent-gates.md 门禁 2/10 补记）。
//   - POST /api/agent/models                        —— 上面这五个端点之外的
//     第六个端点，刻意例外：不查 loadAgentConfig()、不受 enabled 门约束——
//     这是"保存前先测试 provider/baseURL/key"的配置期工具，用户可能还没点
//     启用开关就要看模型下拉框。这个例外不等于"不设防"：它有自己独立的红
//     线（见该路由内的详细注释与 docs/agent-gates.md 门禁 2/9 补记）——
//     apiKey 省略时只有 provider === 'deepseek-official'（baseURL 被
//     validateBaseURL() 钉死成官方域常量，不是任何攻击者可写的值）才允许
//     回落到 env/本机存储的 key；openai-completions 一律要求请求体显式带
//     apiKey，不提供任何自动回落——【2026-08-23 复审修复】此前这里还有第二
//     条"回落到已保存的 agent_base_url 同源"的信任路径，但那个信任锚点本身
//     就是同一个 PUT /api/settings 面可写的，攻击者（典型场景 XSS）只需要
//     先 PUT 把 agent_base_url 改成自己的地址、再 POST 本端点省略 apiKey，
//     两次请求就能把已存的完整明文 key 送到攻击者服务器（复审探针实测复
//     现），已整段删除，不再复用（见 src/agent/config.js 顶部关于
//     baseURLsShareOrigin() 被移除的说明）。baseURL 仍然过与保存设置同一
//     套字符串 SSRF 校验（协议/凭据/内网回环字面量/官方域）——【2026-08-23
//     减法】此前这里在此基础上还额外做一次连接期 DNS 解析 + IP 钉住
//     （resolvePinnedAddress()），已整体移除：该端点本来就在 apiAuth 之后，
//     能调用它的调用方本就能走既有 supervisor 路径达成同等外联（worker 启动
//     路径从未有过这层 DNS 钉住），钉 IP 没有消除风险，只是把门槛从两步变
//     三步；它在真实环境里还会误伤本机跑 fake-ip 类代理的用户（详见
//     src/agent/config.js 顶部关于这次移除的完整理由）。现在与保存设置、
//     worker 启动路径共用同一层纯字符串黑名单，不再对 hostname 做任何 DNS
//     解析——这意味着一个字符串看起来合法、实际解析到内网/回环的公网注册
//     域名（如 `localtest.me` 一类）仍能通过这层校验，这是本轮明确接受的
//     取舍（见 docs/CHANGES.md 与 docs/agent-gates.md 门禁 9）。
//   - proposal accept/decline 不在本文件——继续走既有 inbox 人类路由
//     （src/routes/views.js 的 /api/inbox/:id/accept|decline），本文件不新开
//     任何模型可达的 accept API。
import { Router } from 'express';
import { db, audit } from '../db.js';
import {
  AGENT_SETTINGS_KEYS,
  ALLOWED_AGENT_APPROVAL_TIERS,
  ALLOWED_PROVIDERS,
  agentKeyStatus,
  loadAgentConfig,
  resolveAgentApiKey,
  validateBaseURL,
} from '../agent/config.js';
import { fetchProviderModels, modelsErrorToHttpStatus } from '../agent/models-client.js';

// 一次 prompt 的文本上限：不是纯粹的展示限制,也是成本/滥用防线——案件事实
// 本身已经通过 anqi-owned MCP 工具传给模型,用户手打的这一句话没有理由超过
// 几千字符。与 src/lib/llm.js 的 MAX_TEXT（500，快录条一句话）不是同一个
// 场景,这里是多轮对话式 prompt,给更宽松但仍然有界的上限。
const MAX_PROMPT_CHARS = 8000;
// user-question 每题答案上限,防止把整篇案卷粘贴回答案里绕开"只读工具返回
// 事实"的边界。
const MAX_ANSWER_CHARS = 2000;

const SSE_HEARTBEAT_MS = 25000; // 与 files.js 的 SSE 心跳惯例一致,穿透反代空闲超时

// 案件 id 校验 + 存在性检查。转换成真正的 Number 而不是原样透传字符串——
// AgentSupervisor 下游的 session-registry.bindSession() 对 caseId 做
// Number.isInteger() 硬校验,传字符串会在 supervisor.start() 内部抛出未预期
// 异常,而不是这里可控的 400。
function mustCaseId(req, res) {
  const caseId = Number(req.params.id);
  if (!Number.isInteger(caseId) || caseId <= 0) {
    res.status(400).json({ error: 'case id 非法' });
    return null;
  }
  const row = db.prepare('SELECT id FROM cases WHERE id = ?').get(caseId);
  if (!row) {
    res.status(404).json({ error: '案件不存在' });
    return null;
  }
  return caseId;
}

// 把浏览器提交的问答答案,严格转换成 DSH user-question 协议要求的
// { answers: [{ id, selected, custom }] } 形状(参照参考实现 driver.mjs 的
// questionResult())。校验规则:
//   - 数组长度必须与待答问题数一致,一一对应,不接受少答/多答;
//   - 每个 id 必须命中且只命中一道待答问题(不允许重复 id、不允许编造 id);
//   - 每个答案必须是非空字符串,裁剪后不超过 MAX_ANSWER_CHARS。
// 任何一项不满足都返回 null,调用方一律按 400 处理,不做部分采纳。
function buildQuestionAnswer(pendingQuestions, rawAnswers) {
  if (!Array.isArray(rawAnswers) || rawAnswers.length !== pendingQuestions.length) return null;
  const knownIds = new Set(pendingQuestions.map((q) => q.id));
  const seen = new Set();
  const answers = [];
  for (const item of rawAnswers) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const id = item.id;
    if (typeof id !== 'string' || !knownIds.has(id) || seen.has(id)) return null;
    seen.add(id);
    const text = item.text;
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_ANSWER_CHARS) return null;
    answers.push({ id, selected: [], custom: trimmed });
  }
  if (seen.size !== pendingQuestions.length) return null;
  return { answers };
}

// fetchModels 是 fetchProviderModels() 的依赖注入点（同 AgentSupervisor 的
// spawnFn 一个风格）：生产环境用真实网络实现，测试可以注入假实现验证路由层
// 自己的职责（校验/取值优先级/错误映射/脱敏），不必每次都发起真实网络调用。
export function createAgentRouter(supervisor, {
  fetchModels = fetchProviderModels,
} = {}) {
  const r = Router();

  // 只读:配置层可用性 + (可选)某案件当前 worker 状态。不带 case_id 时只反映
  // 设置白名单是否合法/启用,完全不触碰 supervisor.workers——这就是冒烟脚本
  // 验证"enabled=false 时 status 返回 disabled"的那条路径,disabled 判定
  // 发生在任何数据库案件查询之前。
  r.get('/agent/status', (req, res) => {
    const config = loadAgentConfig();
    if (!config.enabled) {
      // enabled=false 时 agentKeyStatus() 本身也会短路成
      // {configured:false, keySource:'none'}（与 loadAgentConfig() 同一条
      // 红线），这里直接复用同一份判断，不重新发明。
      return res.json({
        status: 'disabled', enabled: false, error: config.error || null, configured: null, worker: null,
        apiKey: { configured: false, keySource: 'none' },
      });
    }
    const configured = { provider: config.provider, model: config.model };
    // key 状态供 UI 展示"当前用的是环境变量还是本机保存的 key"——只回布尔
    // +来源枚举，从不含 key 值本身（agentKeyStatus() 内部实现同样保证这一
    // 点）。
    const apiKey = agentKeyStatus();
    const caseIdRaw = req.query.case_id;
    if (caseIdRaw === undefined || caseIdRaw === '') {
      return res.json({ status: 'stopped', enabled: true, error: null, configured, worker: null, apiKey });
    }
    const caseId = Number(caseIdRaw);
    if (!Number.isInteger(caseId) || caseId <= 0) return res.status(400).json({ error: 'case_id 非法' });
    const caseRow = db.prepare('SELECT id FROM cases WHERE id = ?').get(caseId);
    if (!caseRow) return res.status(404).json({ error: '案件不存在' });
    // 下发安全投影(publicStatus),不带 sessionId/cwd/pid——见 supervisor.js
    // publicStatus() 的注释。
    const worker = supervisor.publicStatus(caseId);
    res.json({ status: worker.status, enabled: true, error: null, configured, worker, apiKey });
  });

  // POST /api/agent/models——设置页"拉取该 key 可用的模型列表"这一步的
  // 服务端实现（设计 4）。刻意不经过 config.enabled 门：这是一个"保存前
  // 先测试 provider/baseURL/key 是否真的能用"的配置期工具，用户可能还没
  // 点击启用开关就已经在填资料、需要看到模型下拉框，不应该被"还没启用"
  // 挡住；它不 spawn 任何子进程、不碰任何案件数据，只对外发起一次只读的
  // GET 请求，风险面与"是否已启用 AI 助理"无关。
  r.post('/agent/models', async (req, res) => {
    const body = req.body || {};
    const provider = String(body.provider ?? '').trim();
    if (!ALLOWED_PROVIDERS.has(provider)) {
      return res.status(400).json({ error: `provider 必须是 ${[...ALLOWED_PROVIDERS].join(' 或 ')}` });
    }

    // baseURL 必须过与保存时同一套安全校验（协议、credential-free、内网/
    // 回环字面量拦截、deepseek-official 官方域钉死）——这一步是防 SSRF 的
    // 唯一一层闸门,不能因为这是"只是拉个列表"的辅助端点就绕过；纯字符串
    // 黑名单堵不住"字符串本身看起来是合法公网域名、DNS 却解析到内网/回环"
    // 这类情形（此前这里还有一层连接期 DNS 解析 + IP 钉住，已整体移除，见
    // src/agent/config.js 顶部关于该决策的完整理由——本端点与 worker 启动
    // 路径现在处于同一条 SSRF 防线水位上，不再有落差）。
    const baseURLResult = validateBaseURL(body.baseURL, provider);
    if (!baseURLResult.ok) {
      return res.status(400).json({ error: baseURLResult.error });
    }
    const baseURL = baseURLResult.normalized;

    // apiKey 省略时,用已保存的/环境变量的(取值优先级链与 loadAgentConfig()
    // 同源,见 resolveAgentApiKey());body.apiKey 只在类型是非空字符串时才
    // 采用——用户在"改 baseURL/model 但没改 key"这种场景下重新拉取列表,
    // 前端没有理由把已经存在服务端的 key 再传一遍。
    //
    // 【红线】只有 provider === 'deepseek-official' 时才允许省略 apiKey 并
    // 回落到 env/本机存储的 key——它的 baseURL 已经被上面的 validateBaseURL()
    // 钉死成官方域常量,不存在"指向任意主机"的可能,不依赖 settings 表里任
    // 何攻击者可写的值。openai-completions 的 baseURL 天然是用户自定义、
    // 可以被同一个登录态的调用方（典型场景 XSS）随时通过 PUT /api/settings
    // 改写,因此这里不提供任何形式的自动回落,一律要求请求体显式带上
    // apiKey——【2026-08-23 复审修复】此前这里还允许"这次的 baseURL 与已
    // 保存的 agent_base_url 同源"时回落,但那个信任锚点本身就是可以被同一
    // 条 PUT 通道改写的,攻击者只需要先 PUT 把 agent_base_url 改成自己的
    // 地址、"同源"判定立刻为真,两次请求就足以把已存的完整明文 key 外带出
    // 去（不经过 config.enabled 门，即使 agent_enabled=false 也成立）,已
    // 整段删除,不再复用。
    let apiKey;
    let apiKeySource;
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      apiKey = body.apiKey.trim();
      apiKeySource = 'request';
    } else if (provider !== 'deepseek-official') {
      audit(req.actor, 'agent-models-fetch-fail', 'agent-models', null, `provider=${provider} reason=custom_provider_requires_explicit_key`);
      return res.status(400).json({
        error: 'openai-completions 的 baseURL 可由客户端随时改写，出于安全考虑该 provider 下拉取模型必须显式在请求中提供 apiKey，不会自动使用已保存/环境变量里的 key；仅 deepseek-official（baseURL 钉死官方域）支持省略 apiKey',
        code: 'api_key_required_for_custom_provider',
      });
    } else {
      const apiKeyEnvRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(AGENT_SETTINGS_KEYS.apiKeyEnv);
      const apiKeyEnv = apiKeyEnvRow ? String(apiKeyEnvRow.value ?? '').trim() : '';
      const resolved = resolveAgentApiKey({ apiKeyEnv });
      apiKey = resolved.value;
      apiKeySource = resolved.source;
    }
    if (!apiKey) {
      return res.status(400).json({ error: '未提供 API Key，且未找到已保存的 key', code: 'api_key_missing' });
    }

    let result;
    try {
      result = await fetchModels({ baseURL, apiKey });
    } catch (error) {
      // fetchProviderModels() 的所有错误分支都带 .code（见
      // src/agent/models-client.js），message 本身已经是脱敏过的中文提
      // 示——这里只做 code → HTTP 状态码映射 + 审计，绝不把 error 本身之外
      // 的任何东西（尤其 apiKey）拼进审计详情。
      const httpStatus = modelsErrorToHttpStatus(error.code);
      audit(req.actor, 'agent-models-fetch-fail', 'agent-models', null, `provider=${provider} reason=${error.code || 'unknown'}`);
      return res.status(httpStatus).json({ error: error.message, code: error.code || 'unknown_error' });
    }

    // 审计只记 provider/来源/数量——绝不含 apiKey、绝不含 baseURL 完整字符
    // 串以外的上游原始响应体。
    audit(req.actor, 'agent-models-fetch', 'agent-models', null, `provider=${provider} key_source=${apiKeySource} count=${result.models.length}`);
    res.json({ models: result.models });
  });

  r.post('/cases/:id/agent/start', async (req, res) => {
    const caseId = mustCaseId(req, res);
    if (caseId == null) return;
    // 路由层自己也查一遍 loadAgentConfig()：不依赖"supervisor.start() 内部
    // 会拒绝"这一件事——之前 supervisor.start() 命中既存 live worker 时会先
    // 返回它的旧状态、根本不看当下配置（见 supervisor.js start() 顶部注释与
    // docs/agent-gates.md 门禁 2/10 补记的运行时缺口），这里在调用 supervisor
    // 之前就先短路，disabled 时压根不进 supervisor.start()，双保险而不是互相
    // 替代。
    const config = loadAgentConfig();
    if (!config.enabled) {
      return res.status(409).json({ error: config.error || 'AI 助理未启用', code: 'agent_disabled', status: 'disabled' });
    }
    let result;
    try {
      result = await supervisor.start(caseId);
    } catch {
      // supervisor.start() 已经把几乎所有已知失败路径转成 resolved 值
      // （disabled/error 状态对象）;这里的 catch 只兜底真正意外抛出的异常,
      // 不把内部错误细节(可能含路径/堆栈)吐回客户端。
      return res.status(500).json({ error: 'AI 助理启动失败', code: 'internal_error' });
    }
    if (result.status === 'disabled') {
      return res.status(409).json({ error: result.error || 'AI 助理未启用', code: 'agent_disabled', status: result.status });
    }
    if (result.status === 'error') {
      return res.status(502).json({ error: result.error || 'AI 助理启动失败', code: 'agent_start_failed', status: result.status });
    }
    // 成功态同样只下发安全投影：supervisor.start() 的 resolve 值是完整的
    // status()（含内部 sessionId、宿主机绝对 cwd、子进程 pid），原样 res.json
    // 出去就等于把 GET /agent/status 与 SSE 首帧刚脱敏掉的三个字段从启动响应
    // 这条路补回去。权威投影只有 supervisor.publicStatus() 一份，这里不另抄
    // 字段列表。
    res.json(supervisor.publicStatus(caseId));
  });

  r.post('/cases/:id/agent/prompt', (req, res) => {
    const caseId = mustCaseId(req, res);
    if (caseId == null) return;
    // disabled 时 fail-closed，且必须在任何其它校验/supervisor 调用之前判
    // 断——此前这里完全没有查过 loadAgentConfig()，只看 supervisor.isLive()：
    // 只要设置刚好还没来得及停掉一个存活 worker（或者压根没人管这一段窗
    // 口），一条 prompt 就能被受理（202）并真的写进子进程 stdin，这正是编排
    // 方人工验收复现的红线缺陷之一（agent-prompt 审计时间戳晚于 settings
    // update）。
    const config = loadAgentConfig();
    if (!config.enabled) {
      return res.status(409).json({ error: config.error || 'AI 助理未启用', code: 'agent_disabled' });
    }
    const raw = req.body?.text;
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return res.status(400).json({ error: 'text 不能为空' });
    if (text.length > MAX_PROMPT_CHARS) {
      return res.status(400).json({ error: `text 过长（上限 ${MAX_PROMPT_CHARS} 字符）` });
    }
    // 权威判断留在 supervisor.isLive()——不在这里复刻它的状态机字面量集合
    // （见 src/agent/supervisor.js isLive() 的注释）;badge 只是取来拼错误
    // 消息用的展示字段。
    const badge = supervisor.status(caseId).status;
    if (!supervisor.isLive(caseId)) {
      return res.status(409).json({ error: 'AI 助理当前不在运行状态', code: 'worker_not_running', status: badge });
    }
    audit(req.actor, 'agent-prompt', 'agent-worker', caseId, `chars=${text.length}`);
    // 不 await 整轮完成:一次 turn 可能耗时到 supervisor 的 turnTimeoutMs
    // （默认 10 分钟）,HTTP 请求/反向代理/浏览器都不适合被这么长的调用阻塞。
    // 真正的进度与最终结果只经由 SSE 的 turn/start ... turn/end 事件下行
    // （GET .../agent/events）;这里做的只是上面这行同步的、尽力而为的门禁
    // 校验——如果 worker 恰好在这一行判断之后、supervisor.prompt() 真正执行
        // 之前退出,turn 会在 supervisor 内部落一个 fail 态,只是不会有对应的
    // turn/start 事件,调用方应以 SSE/status 而非这个 202 作为权威依据。
    supervisor.prompt(caseId, text).catch(() => { /* 失败结果经 turn/end 广播,这里只防 unhandledRejection */ });
    res.status(202).json({ accepted: true });
  });

  // 每个 live session/案件的审批档临时旋钮。只接受 1/2/3；caseId 来自路由
  // 且先查真实案件，session/worker 归属完全由 supervisor 内部决定。全局默认
  // 仍在 /api/settings 的 agent_approval_tier，本端点不写 DB。
  r.post('/cases/:id/agent/approval-tier', (req, res) => {
    const caseId = mustCaseId(req, res);
    if (caseId == null) return;
    const config = loadAgentConfig();
    if (!config.enabled) return res.status(409).json({ error: 'AI 助理未启用', code: 'agent_disabled' });
    const approvalTier = String(req.body?.approvalTier ?? '').trim();
    if (!ALLOWED_AGENT_APPROVAL_TIERS.has(approvalTier)) {
      return res.status(400).json({ error: 'approvalTier 必须是 1、2 或 3', code: 'invalid_tier' });
    }
    const result = supervisor.setApprovalTier(caseId, approvalTier);
    if (!result.ok) {
      return res.status(409).json({ error: 'AI 助理当前不在运行状态', code: result.reason || 'unavailable' });
    }
    audit(req.actor, 'agent-approval-tier', 'agent-worker', caseId, `tier=${approvalTier}`);
    return res.json(result);
  });

  r.post('/cases/:id/agent/cancel', (req, res) => {
    const caseId = mustCaseId(req, res);
    if (caseId == null) return;
    // disabled 时同样 fail-closed：关掉开关之后这个案件不应该再有任何
    // agent 端点可用——真正的存活 worker 已经由 settings 路由/supervisor 的
    // stop() 收尾，这里不是"取消一个本不该存在的 turn"的正常路径。
    const config = loadAgentConfig();
    if (!config.enabled) {
      return res.status(409).json({ error: config.error || 'AI 助理未启用', code: 'agent_disabled' });
    }
    const cancelled = supervisor.cancelTurn(caseId, `cancelled by ${req.actor}`);
    audit(req.actor, 'agent-cancel', 'agent-worker', caseId, cancelled ? 'ok' : 'no_active_turn');
    res.json({ cancelled });
  });

  // authenticated SSE。服务端按 case 过滤:supervisor.onEvent(caseId, ...)
  // 只转发这一个 case 的 worker 广播的事件,不接受、也不需要客户端提交任何
  // session id 做筛选依据——设计稿 §4 的「不把浏览器传来的任意 session ID
  // 当作权限依据」在这里的落地就是压根不读这样一个参数。
  r.get('/cases/:id/agent/events', (req, res) => {
    const caseId = mustCaseId(req, res);
    if (caseId == null) return;

    // config.enabled=false 时与 GET /api/agent/status 用同一个判定短路：连接
    // 仍然建立（前端不需要区分"没配置"和"网络失败"两种连不上），但首帧直接
    // 下发 status:'disabled'，不触碰 supervisor.publicStatus()/worker 状态——
    // enabled=false 时本来就不可能有存活 worker,但语义上仍应该和 REST 的
    // /api/agent/status 一致,不能让 SSE 这条平行路径在同一份配置下给出不同
    // 判断(例如误报 'stopped' 而不是 'disabled')。
    const config = loadAgentConfig();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

    if (!config.enabled) {
      send('status', { status: 'disabled', caseId, error: config.error || null });
      const hb = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
      req.on('close', () => { clearInterval(hb); res.end(); });
      return;
    }

    // 首帧补一份即时状态快照:onEvent() 的监听器可能在 worker 已经经历过若干
    // 次状态跃迁之后才挂上(例如 worker 早已 ready,'worker/ready' 广播已经
    // 错过),不补发这一帧,前端在连接建立瞬间只能拿到"未知",要等下一次真正
    // 的事件才恢复准确状态。下发安全投影,不带 sessionId/cwd/pid。
    const snapshot = supervisor.publicStatus(caseId);
    send('status', { ...snapshot, approvalTier: snapshot.approvalTier || config.approvalTier });

    // 转发的每一帧也要走同一条脱敏尺度:Worker.emit() 组装的内部事件形状是
    // { type, caseId, sessionId, at, origin, data }——sessionId 是 supervisor
    // 侧 session→case 登记表的键(见 src/agent/session-registry.js),属于上面
    // publicStatus() 刻意不下发的那一类内部标识,不能因为它换了一条通路
    // (事件而不是状态快照)就原样广播出去。data 已经在 supervisor 侧逐叶子
    // 做过 secret redaction + 长度截断,这里只做字段投影,不重复过滤。origin
    // ('supervisor'/'wire')随字段透出,供前端/探针区分事件来源可信度——
    // wire 侧 type 撞名时已经在 supervisor 侧被重写成 wire/<type>(见
    // supervisor.js 的 namespaceWireEventType()),这里只是把标记透传出去。
    const unsubscribe = supervisor.onEvent(caseId, (event) => send(event.type, {
      type: event.type,
      caseId: event.caseId,
      at: event.at,
      origin: event.origin,
      data: event.data,
    }));

    const hb = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(hb);
      unsubscribe();
      res.end();
    });
  });

  // one-shot、fail-closed 的 approval/question 回答面。interactionId 是唯一
  // 入参:caseId/worker/该交互的类型与待答问题,全部由服务端反查得到,不接受
  // 任何客户端提交的 case_id/session_id/cwd(设计稿 §4)。
  r.post('/agent/interactions/:id/answer', (req, res) => {
    // disabled 时 fail-closed，且必须先于 findInteractionOwner()：关掉开关之
    // 后不应该还存在任何可以被回答的待办交互（对应的 worker 应该早就被
    // settings 路由触发的 stopAll() 停掉、pendingInteractions 也随之清空），
    // 这里的检查是不信任"调用方/时序恰好保证了这一点"的兜底闸门。
    const config = loadAgentConfig();
    if (!config.enabled) {
      audit(req.actor, 'agent-interaction-answer-fail', 'agent-interaction', null, 'agent_disabled');
      return res.status(409).json({ error: 'AI 助理未启用', code: 'agent_disabled' });
    }
    const interactionId = String(req.params.id || '');
    const owner = supervisor.findInteractionOwner(interactionId);
    if (!owner) {
      audit(req.actor, 'agent-interaction-answer-fail', 'agent-interaction', null, 'not_found_or_expired');
      return res.status(404).json({ error: '该交互不存在或已过期', code: 'interaction_not_found' });
    }
    const { caseId, record } = owner;
    const body = req.body || {};

    if (record.type === 'approval') {
      // outcome 的合法取值(allowed-once/rejected)由 supervisor.resolveApproval()
      // 内部的 APPROVAL_EXTERNAL_OUTCOMES 白名单校验——"受限 outcome"这条红线
      // 的权威判断留在 supervisor 一处,这里不重复维护第二份白名单。
      const outcome = body.outcome;
      const rememberTool = body.rememberTool;
      if (rememberTool !== undefined && typeof rememberTool !== 'boolean') {
        audit(req.actor, 'agent-interaction-answer-fail', 'agent-interaction', null, `case=${caseId} approval:invalid_remember`);
        return res.status(400).json({ error: 'rememberTool 必须是布尔值', code: 'invalid_remember' });
      }
      if (rememberTool === true && outcome !== 'allowed-once') {
        audit(req.actor, 'agent-interaction-answer-fail', 'agent-interaction', null, `case=${caseId} approval:invalid_remember`);
        return res.status(400).json({ error: '只有允许操作才能记住本类放行', code: 'invalid_remember' });
      }
      const result = supervisor.resolveApproval(caseId, interactionId, outcome, { rememberTool: rememberTool === true });
      if (!result.ok) {
        audit(req.actor, 'agent-interaction-answer-fail', 'agent-interaction', null, `case=${caseId} approval:${result.reason}`);
        return res.status(result.reason === 'invalid_outcome' ? 400 : 409).json({ error: '提交审批结果失败', code: result.reason });
      }
      audit(req.actor, 'agent-interaction-answer', 'agent-interaction', null, `case=${caseId} approval:${outcome}${rememberTool === true ? ':remember-tool' : ''}`);
      return res.json({ ok: true });
    }

    if (record.type === 'question') {
      const built = buildQuestionAnswer(record.questions, body.answers);
      if (!built) {
        audit(req.actor, 'agent-interaction-answer-fail', 'agent-interaction', null, `case=${caseId} question:invalid_answer`);
        return res.status(400).json({ error: '答案格式不合法', code: 'invalid_answer' });
      }
      const result = supervisor.resolveQuestion(caseId, interactionId, built);
      if (!result.ok) {
        audit(req.actor, 'agent-interaction-answer-fail', 'agent-interaction', null, `case=${caseId} question:${result.reason}`);
        return res.status(409).json({ error: '提交答案失败', code: result.reason });
      }
      audit(req.actor, 'agent-interaction-answer', 'agent-interaction', null, `case=${caseId} question`);
      return res.json({ ok: true });
    }

    return res.status(500).json({ error: '未知的交互类型' });
  });

  return r;
}

export default createAgentRouter;
