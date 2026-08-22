import { Router } from 'express';
import { db, audit } from '../db.js';
import {
  AGENT_SETTINGS_KEYS,
  ALLOWED_PROVIDERS,
  ENV_NAME_RE,
  agentKeyStatus,
  isReservedEnvName,
  loadAgentConfig,
  resolveAgentApiKey,
  validateBaseURL,
} from '../agent/config.js';
import { encryptSecret, maskSecret, resolveMasterKey } from '../lib/secret-box.js';

// agent_api_key 明文入参的长度上限——纯粹是防御式的 DoS/误用兜底（真实
// API key 从没见过超过几百字符的），不是安全边界本身：加密/落库对任意长度
// 字符串都能正确处理，这里只是拒绝明显不像 key 的超长输入，避免整条巨大字
// 符串被加密后长期占用 settings 表一行。
const MAX_API_KEY_LENGTH = 4096;

// 系统设置（键值）。「用户中心 · 个人设置」六个抬头字段——纯展示信息，不进
// 期限引擎、不进任何计算、无 LLM 通道；加上 DSH sidecar 的 agent_* 五键
// （设计稿 §1 白名单：enabled/provider/baseURL/model/apiKeyEnv）。
//
// 白名单是硬门：PUT 只认下面这十一个键，其余**直接丢弃**（不报错、不落库）。
// agent_* 五键额外过一遍类型/格式校验（与 src/agent/config.js 的
// loadAgentConfig() 共用同一份 provider 枚举/环境变量名正则/baseURL 协议与
// 域策略——两处一旦各写一份就会出现"设置页存得进去，但 supervisor 启动时
// 又被拒绝"的不一致），校验不过整批 PUT 直接 400、一个键都不落；apiKeyEnv
// 全程只存变量名，本文件不读取、不返回、不缓存该变量名对应的环境变量值。
//
// 设置侧联动（设计稿 §1「enabled=false 必须在……spawn 子进程之前短路返回」
// 与门禁 2/10「关掉即不存在」的另一半）：这批 PUT 一旦把 agent_* 五键落库成
// 一份 config.enabled 为假的状态，必须同时终止所有已经在跑的 live worker——
// 否则「设置页关掉开关」与「worker 真的停下来」是两件不同步的事，编排方人工
// 验收正是在这条缝隙上实测复现的红线（已启动的 DSH 子进程在关掉开关 14 分钟
// 后仍在跑）。触发这条收尾的绝大多数情况是用户显式把 agent_enabled 关掉；
// provider/model/apiKeyEnv 三个字段本身走的是与 loadAgentConfig() 完全同源
// 的格式/枚举校验（见下方 validateAgentFields），格式不合法的值在这里已经
// 400 拒绝、根本不会落库，所以"落库成功但 loadAgentConfig() 判它不可用"这条
// 路径几乎不会由这三个字段的本次改动直接触发——唯一现实的窄口子是：数据库里
// 已经存在一份历史上就不自洽的存量态（例如上一次改了 provider 但 base_url
// 早已对新 provider 非法），而本次 PUT 只碰了其中某个 agent_* 键、没有同时
// 碰 agent_base_url/agent_provider（因此不会走下面对 baseURL 的
// 重新校验分支），落库后重读到的仍是那份历史非法态。下面统一用同一份
// loadAgentConfig() 复查，不区分具体是哪种情况触发的——这里只负责兜底，不
// 假设"改 provider/model/apiKeyEnv 通常会让 enabled 变假"（它通常不会，
// apiKeyEnv 尤其如此：loadAgentConfig() 只校验变量名格式与保留名，从不读取
// process.env[apiKeyEnv] 是否真的存在，那是 agentReady() 的职责）。
//
// 范围边界（已知、非本轮红线，留作后续跟进）：这条联动只在配置变成
// disabled 时才收敛 live worker；配置仍然 enabled 的改动（例如把
// agent_model 从 A 改成 B）不会重建或重启 live worker——PUT 本身会 200、
// GET /api/settings 会显示新值，但已经在跑的 worker 是拿着 spawn 那一刻的
// 旧值继续跑的，"设置页显示的模型"与"worker 实际在用的模型"会静默不一致，
// 直到该 worker 因为别的原因（案件关闭、进程重启等）自然回收。这与「关掉即
// 不存在」是同一条 settings↔supervisor 缝隙的另一半，但不在本轮任务范围内。
//
// 本文件因此改成工厂函数 createSettingsRouter(supervisor)——与
// src/routes/agent.js 的 createAgentRouter(supervisor) 同一种接线方式：
// server.js 只 new 一个 AgentSupervisor 实例，同时注入 agentRouter 与
// settingsRouter，两边共用同一个实例调用 stopAll()。不让本文件直接
// `import { AgentSupervisor } from '../agent/supervisor.js'` 自己 new 一个或
// 引用某个模块级单例：那样要么产生"两份 supervisor 各管一半 worker"的分裂
// 状态，要么迫使 supervisor.js 反过来引用 settings.js 形成循环依赖——工厂
// 注入把这个依赖方向的决定权留给 server.js（谁先构造、谁传给谁），本文件自己
// 不持有、也不构造 supervisor。
export function createSettingsRouter(supervisor) {
  const r = Router();

  const ALLOWED = ['name', 'license_no', 'firm', 'phone', 'email', 'address'];
  // 存储层键名（settings 表里真实的行名）——GET 响应要把其中的
  // agent_api_key_encrypted 过滤掉，绝不把密文原样吐给前端（虽然密文不是
  // 明文，但没有正当理由顺手带出去，见文件顶部注释）。
  const AGENT_STORAGE_KEYS = Object.values(AGENT_SETTINGS_KEYS);
  // PUT body 里认的 agent_* 键名——比存储键名多一个 'agent_api_key'：这是
  // 用户在界面填的明文 key，落库前会被加密进 AGENT_SETTINGS_KEYS.apiKeyEncrypted
  // 那一行,body 键名与存储键名故意不同,避免调用方以为"传进去的就是存进去
  // 的原始字符串"。
  const AGENT_BODY_KEYS = [...AGENT_STORAGE_KEYS.filter((k) => k !== AGENT_SETTINGS_KEYS.apiKeyEncrypted), 'agent_api_key'];

  function readAgentSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? String(row.value ?? '') : '';
  }

  // 校验本次 PUT 里出现的 agent_* 字段，返回
  //   { ok:true, values:{ agent_xxx: normalizedStringValue, ... } }（只含 body
  //     里显式出现过的键，未提及的键不受影响、也不重写）
  //   { ok:false, error }
  // baseURL 依赖 provider 做官方域策略：只要 body 触及 agent_base_url 或
  // agent_provider 其中之一，就用"本次生效中的 provider"（body 优先，否则
  // 回落到已落库的值）把 baseURL 重新校验一遍，避免出现"改了 provider，但
  // 历史 baseURL 对新 provider 已经非法却没人检查"的悬空态；不过重新校验
  // 通过之后，只有 body 真正提交了 agent_base_url 才会落库覆盖旧值。
  function validateAgentFields(body) {
    const touches = (key) => Object.prototype.hasOwnProperty.call(body, key);
    const values = {};

    if (touches('agent_enabled')) {
      if (typeof body.agent_enabled !== 'boolean') {
        return { ok: false, error: 'agent_enabled 必须为布尔值' };
      }
      values.agent_enabled = body.agent_enabled ? 'true' : 'false';
    }

    if (touches('agent_provider')) {
      const provider = String(body.agent_provider ?? '').trim();
      if (!ALLOWED_PROVIDERS.has(provider)) {
        return { ok: false, error: `agent_provider 必须是 ${[...ALLOWED_PROVIDERS].join(' 或 ')}` };
      }
      values.agent_provider = provider;
    }

    if (touches('agent_model')) {
      const model = String(body.agent_model ?? '').trim();
      if (!model) return { ok: false, error: 'agent_model 不能为空' };
      values.agent_model = model;
    }

    // apiKeyEnv 现在是可选高级项（设计 5）：留空表示"不走环境变量，用界面
    // 存的加密 key"，不再是非法输入；但一旦填了非空值，格式/保留名校验尺度
    // 不变——不能因为"现在可选"就顺带放松已经存在的红线。
    if (touches('agent_api_key_env')) {
      const apiKeyEnv = String(body.agent_api_key_env ?? '').trim();
      if (apiKeyEnv) {
        if (!ENV_NAME_RE.test(apiKeyEnv)) {
          return { ok: false, error: 'agent_api_key_env 必须是合法的环境变量名（不是 key 本身）' };
        }
        if (isReservedEnvName(apiKeyEnv)) {
          return { ok: false, error: 'agent_api_key_env 不得使用 anqi 自身的保留变量名/前缀' };
        }
      }
      values.agent_api_key_env = apiKeyEnv;
    }

    // 界面填的明文 key（设计 2/3）：落库前加密，本函数返回值里也只有密文，
    // 从不是明文本身——PUT 响应体最终由下面的 buildAgentKeyView() 单独构建
    // 掩码/布尔视图，绝不会把这里算出来的密文或调用方传入的明文原样回显。
    // 空字符串是显式"清空已存 key"的信号（用户想切回纯环境变量模式），不是
    // 非法输入，加密一个空串没有意义，直接存空串表示"没有已存 key"。
    if (touches('agent_api_key')) {
      if (typeof body.agent_api_key !== 'string') {
        return { ok: false, error: 'agent_api_key 必须为字符串' };
      }
      const original = body.agent_api_key;
      // 落库前 trim：复制粘贴 API key 时带上首尾空白/换行是最高频的用户
      // 错误——不 trim 的话，这个错误会被静默存成密文，直到"拉取模型/实际
      // 调用"那一步才以一条完全误导的 network_error（undici 会拒绝带 \n 的
      // 请求头）表现出来，用户看不出真实原因是 key 尾部多了个换行。POST
      // /api/agent/models 的请求体分支（src/routes/agent.js）已经在 trim，
      // 这里补上是为了让"拉取模型当场成功、保存后实跑却失败"这种不对称
      // 消失——两条路径必须对同一份输入做同样的规整。
      const trimmed = original.trim();
      // 纯空白输入（如粘贴时不小心带上的空格串）显式拒绝，不当成"清空 key"
      // 静默接受——那样会让 GET /api/settings 显示 configured:true、
      // agentReady() 判定为可用，但 supervisor 实际会拿一把空白 key 去启动
      // worker。真正的"清空已存 key"信号是显式传空字符串（下面单独处理），
      // 不是传一串看起来非空、trim 后却什么都不剩的空白。
      if (original.length > 0 && !trimmed) {
        return { ok: false, error: 'agent_api_key 不能是纯空白字符' };
      }
      if (trimmed.length > MAX_API_KEY_LENGTH) {
        return { ok: false, error: `agent_api_key 过长（上限 ${MAX_API_KEY_LENGTH} 字符）` };
      }
      values[AGENT_SETTINGS_KEYS.apiKeyEncrypted] = trimmed ? encryptSecret(trimmed, resolveMasterKey()) : '';
    }

    if (touches('agent_base_url') || touches('agent_provider')) {
      const effectiveProvider = touches('agent_provider')
        ? values.agent_provider
        : readAgentSetting(AGENT_SETTINGS_KEYS.provider).trim();
      const baseURLRaw = touches('agent_base_url')
        ? body.agent_base_url
        : readAgentSetting(AGENT_SETTINGS_KEYS.baseURL);
      const result = validateBaseURL(baseURLRaw, effectiveProvider);
      if (!result.ok) return { ok: false, error: `agent_base_url: ${result.error}` };
      if (touches('agent_base_url')) values.agent_base_url = result.normalized;
    }

    return { ok: true, values };
  }

  // GET/PUT /api/settings 共用的响应体构造：
  //   - settings 表的原始行原样带出（六个人工字段 + agent_enabled/provider/
  //     baseURL/model/apiKeyEnv 五个白名单字段），但把 agent_api_key_encrypted
  //     这一行剔除——密文本身虽不是明文，但没有正当理由顺手带出去。
  //   - 额外附三个只读计算字段供前端展示："配置来自哪里/是否已配置/掩码"，
  //     一律经 resolveAgentApiKey()（同 loadAgentConfig() 取值链完全同源）
  //     + maskSecret() 算出，绝不把 resolveAgentApiKey() 返回的明文原样吐
  //     出去。这里刻意不经过 config.enabled 门（不调用 agentKeyStatus()）：
  //     设置页本身就是"配置尚未启用时"的编辑现场，用户需要在还没勾选
  //     agent_enabled 之前就能看到"我刚存的 key 是否被认出来了"。
  function buildSettingsView() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const view = Object.fromEntries(
      rows
        .filter((row) => row.key !== AGENT_SETTINGS_KEYS.apiKeyEncrypted)
        .map((row) => [row.key, row.value])
    );
    const apiKeyEnv = String(view[AGENT_SETTINGS_KEYS.apiKeyEnv] ?? '').trim();
    const { value, source } = resolveAgentApiKey({ apiKeyEnv });
    view.agent_api_key_configured = !!value;
    view.agent_api_key_source = source;
    view.agent_api_key_masked = value ? maskSecret(value) : null;
    return view;
  }

  r.get('/settings', (req, res) => {
    res.json(buildSettingsView());
  });

  r.put('/settings', async (req, res) => {
    const body = req.body || {};

    let agentValues = {};
    const touchesAnyAgentKey = AGENT_BODY_KEYS.some((key) => Object.prototype.hasOwnProperty.call(body, key));
    if (touchesAnyAgentKey) {
      const validated = validateAgentFields(body);
      if (!validated.ok) return res.status(400).json({ error: validated.error });
      agentValues = validated.values;
    }

    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    const pairs = [
      ...ALLOWED
        .filter((k) => Object.prototype.hasOwnProperty.call(body, k))
        .map((k) => [k, String(body[k] ?? '')]),
      ...Object.entries(agentValues),
    ];
    // 逐键 upsert，整体一个事务：要么这一批键全落，要么一个都不落。
    const written = db.transaction((rows) => {
      for (const [k, v] of rows) upsert.run(k, v);
      return rows.map(([k]) => k);
    })(pairs);

    audit(req.actor, 'update', 'settings', null, written.join(','));

    // 联动收尾：只在这次 PUT 真的触碰过 agent_* 白名单键时才检查——非
    // agent 字段（姓名/电话等六个抬头字段）的普通保存不应该白白多算一次
    // loadAgentConfig()/stopAll() 开销，也没有必要（不可能因为改了电话号码
    // 就让 config.enabled 变化）。落库之后立刻用同一份 loadAgentConfig()
    // 重新读一遍最终生效的配置，不只单独检查这次 body 里的 agent_enabled 是
    // 不是 false——这样写是为了不假设"关掉"只能通过那一个字段发生，覆盖住
    // 顶部注释里提到的历史存量态窄口子（本次 PUT 没碰 base_url/provider，
    // 但重读到的是一份历史上就已经对当前 provider 非法的 base_url）。这**不**
    // 是在说 provider/model/apiKeyEnv 本身的改动通常会让 enabled 变假：这三
    // 个字段在上面 validateAgentFields() 里已经和 loadAgentConfig() 走同一套
    // 格式/枚举/保留名校验，格式不合法的值本次 PUT 早就 400 拒绝、根本落不了
    // 库；尤其 apiKeyEnv，loadAgentConfig() 只校验变量名格式，从不检查
    // process.env[apiKeyEnv] 是否真的有值（那是 agentReady() 的职责），所以
    // 把它改成一个当前环境里并不存在的变量名并不会触发这里的 stopAll()。
    if (touchesAnyAgentKey) {
      const config = loadAgentConfig();
      if (!config.enabled && supervisor && typeof supervisor.stopAll === 'function') {
        const reason = config.error ? `disabled-by-settings:${config.error}` : 'disabled-by-settings';
        // 这里是同步 await：这次 PUT 的响应要等 stopAll() 真正跑完才返回，
        // 是刻意的取舍——响应到达即代表 worker 真的停了，前端不需要再轮询
        // 确认，回归测试也不用为"设置已落库但 worker 还在收尾"这种时序补
        // 竞态断言。代价是响应时长绑定在 stop() 流程上：单个 worker 最坏
        // 情况是 30s 的 shutdown RPC 超时（见下方 `_request(..., 30_000)`）
        // 加 10s 的退出等待（`timeoutPromise(10_000, ...)`），约 40s 上界；
        // 多 worker 走 `Promise.allSettled` 并行等待，不会线性叠加。真实
        // DSH 子进程实测只要 26–151ms 就能完成 shutdown 握手，所以这个上界
        // 目前不是实际问题，但前端 `public/js/api.js` 的 fetch 调用没有设
        // 客户端超时——真遇到卡死的 worker，UI 上会表现为"保存设置"长时间
        // 无响应而不是明确报错，值得知道。
        try {
          await supervisor.stopAll(reason);
        } catch (error) {
          // stopAll() 内部单个 worker 的 stop() 已经有自己的强杀兜底，这里
          // 理论上不应该抛——万一真的抛了，也不能让"设置已经落库成功"这件
          // 事因为收尾失败而回滚成 500：设置本身是对的，只是留一条审计供事后
          // 排查，不影响这次 PUT 的响应。
          audit(req.actor, 'agent-settings-stop-fail', 'agent-worker', null, String(error?.message || error).slice(0, 200));
        }
      }
    }

    res.json(buildSettingsView());
  });

  return r;
}

export default createSettingsRouter;
