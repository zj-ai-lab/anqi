import { Router } from 'express';
import { db, audit } from '../db.js';
import {
  AGENT_SETTINGS_KEYS,
  ALLOWED_PROVIDERS,
  ENV_NAME_RE,
  isReservedEnvName,
  loadAgentConfig,
  validateBaseURL,
} from '../agent/config.js';

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
// 一份 config.enabled 为假的状态（不管是用户显式把 agent_enabled 关掉，还是
// 把 provider/model/apiKeyEnv 改成非法值导致 loadAgentConfig() 判定不可
// 用），必须同时终止所有已经在跑的 live worker——否则「设置页关掉开关」与
// 「worker 真的停下来」是两件不同步的事，编排方人工验收正是在这条缝隙上实测
// 复现的红线（已启动的 DSH 子进程在关掉开关 14 分钟后仍在跑）。
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
  const AGENT_KEYS = Object.values(AGENT_SETTINGS_KEYS);

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

    if (touches('agent_api_key_env')) {
      const apiKeyEnv = String(body.agent_api_key_env ?? '').trim();
      if (!ENV_NAME_RE.test(apiKeyEnv)) {
        return { ok: false, error: 'agent_api_key_env 必须是合法的环境变量名（不是 key 本身）' };
      }
      if (isReservedEnvName(apiKeyEnv)) {
        return { ok: false, error: 'agent_api_key_env 不得使用 anqi 自身的保留变量名/前缀' };
      }
      values.agent_api_key_env = apiKeyEnv;
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

  r.get('/settings', (req, res) => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    res.json(Object.fromEntries(rows.map((row) => [row.key, row.value])));
  });

  r.put('/settings', async (req, res) => {
    const body = req.body || {};

    let agentValues = {};
    const touchesAnyAgentKey = AGENT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(body, key));
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
    // 重新读一遍最终生效的配置——不只看这次 body 里的 agent_enabled 是不是
    // false：把 provider/model/apiKeyEnv 改成白名单校验能通过、但
    // loadAgentConfig() 运行时判定不可用的值（例如 apiKeyEnv 改成一个和当前
    // provider 不搭的名字导致后续 spawn 必然失败——现有校验不拦这种"值合法
    // 但语义上配不齐"的组合），同样等价于「不可用」，同样必须停掉所有 live
    // worker，不能只在用户显式点了开关这一种情况下才收尾。
    if (touchesAnyAgentKey) {
      const config = loadAgentConfig();
      if (!config.enabled && supervisor && typeof supervisor.stopAll === 'function') {
        const reason = config.error ? `disabled-by-settings:${config.error}` : 'disabled-by-settings';
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

    const rows = db.prepare('SELECT key, value FROM settings').all();
    res.json(Object.fromEntries(rows.map((row) => [row.key, row.value])));
  });

  return r;
}

export default createSettingsRouter;
