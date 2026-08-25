// 用户中心：皮肤选择卡 + 个人设置 + 退出会话 + 关于（规则/词表数走 /api/meta）
//
// 皮肤契约（v2「一个骨架 · 三种材质」）：
//   · 卡片属性是 data-skin-value（旧名 data-theme-value 已废）→ dataset.skinValue
//   · 值域 pro | paper | jade | auto，与顶栏 .sk 三键共用 skin.js 一套状态机
//   · .selected / aria-pressed 由 skin.js 的 syncSwitchers() 全局维护——
//     mountNav() → initSkinSwitcher() → apply() 已扫过本页卡片，setSkin() 每次切换也重扫。
//     本文件只把「点击 / 键盘」翻译成 setSkin()，外加一次兜底同步（顶栏挂载失败时也不留错态）。
import { mountNav } from './nav.js';
import { setSkin, getSkin, getResolvedSkin } from './skin.js';
import { api, toast } from './api.js';
import { buildModelOptions } from './agent-model-options.js';

await mountNav();

// 账户与安全 / 关于：两条事实条，「展开/收起」就地展开同条内详情，不走 fold.js
const bindStrip = (toggleId, moreId) => {
  const toggle = document.getElementById(toggleId);
  const more = document.getElementById(moreId);
  if (!toggle || !more) return;
  toggle.addEventListener('click', () => {
    const open = more.hasAttribute('hidden');
    if (open) more.removeAttribute('hidden'); else more.setAttribute('hidden', '');
    toggle.classList.toggle('is-active', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? '收起' : '展开';
  });
};
bindStrip('profile-security-toggle', 'profile-security-more');
bindStrip('profile-about-toggle', 'profile-about-more');

const $ = (id) => document.getElementById(id);

/* ── 皮肤选择卡 ── */
const SKIN_LABEL = { pro: '专业 · 亮', paper: '纸感 · 亮', jade: '翡翠 · 暗' };
const cards = document.querySelectorAll('.theme-card');
const nowEl = $('skin-now');

/** p-foot 的「当前生效」：auto 时要把落地皮肤也说出来，否则用户看不出跟随到了哪边 */
function paintNow() {
  if (!nowEl) return;
  const pref = getSkin();
  const eff = SKIN_LABEL[getResolvedSkin()];
  nowEl.textContent = pref === 'auto' ? `跟随系统 → ${eff}` : eff;
}

function choose(c) {
  setSkin(c.dataset.skinValue);   // 写盘 + 落 DOM + 同步全站切换器（含本页卡片）
}

cards.forEach((c) => {
  c.addEventListener('click', () => choose(c));
  c.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(c); }
  });
});

// 初始选中态兜底（正常路径下 skin.js 已经设过一遍，这里是幂等重放）
const cur = getSkin();
cards.forEach((c) => {
  const on = c.dataset.skinValue === cur;
  c.classList.toggle('selected', on);
  c.setAttribute('aria-pressed', String(on));
});
paintNow();

// 「当前生效」要跟上**每一条**换肤路径，不只本页卡片——两个触发器缺一不可：
//  ① data-skin 变了：本页卡片、顶栏 .sk 三键、跨标签页 storage 同步都会走到这。
//     （auto 表达为「移除属性」，removeAttribute 同样产生 mutation record。）
//  ② auto 状态下 OS 翻转配色：属性一直是「不存在」，压根没有 mutation，
//     真正换肤的是 CSS 媒体查询——只能靠 matchMedia 兜这一路。
new MutationObserver(paintNow).observe(document.documentElement, { attributeFilter: ['data-skin'] });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintNow);

/* ── 个人设置：加载回填 → 保存落库 ──
   六个纯展示型抬头字段，白名单在 src/routes/settings.js（服务端才是权威门）。
   通知偏好面板已随 014 一并删除：那两个阈值（3/7 天）硬编码在前后端 8 处以上，
   做成可配置是另一件事，留着一块全禁用的假控件只会让人以为能改。 */
const SETTING_KEYS = ['name', 'license_no', 'firm', 'phone', 'email', 'address'];
const saveBtn = $('set-save');

if (saveBtn) {
  api('/settings').then((s) => {
    for (const k of SETTING_KEYS) {
      const el = $('set-' + k);
      if (el && s[k] != null) el.value = s[k];
    }
  }).catch(() => { /* 读不到就留空，不拦着用户填 */ });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const body = {};
      for (const k of SETTING_KEYS) {
        const el = $('set-' + k);
        if (el) body[k] = el.value.trim();
      }
      await api('/settings', { method: 'PUT', body });
      toast('设置已保存');
    } catch (e) {
      toast('保存失败：' + (e.message || e));
    } finally {
      saveBtn.disabled = false;
    }
  });
}

/* ── AI 助理（DSH sidecar）：enabled 开关 + provider/baseURL/model/apiKey 易用性改造 ──
   白名单/格式/协议/保留名/SSRF 校验的权威在 src/agent/config.js +
   src/routes/settings.js 的 agent_* PUT 分支、src/routes/agent.js 的
   POST /api/agent/models；本文件只做「读回填 → 供应商联动 → 拉模型 → 折叠 →
   保存」，不在前端重复一遍校验规则——校验不过就让 api() 的失败 toast 把服务端
   error 显示出来，与全站其它表单一致。*/
const agentEnabled = $('agent-enabled');
const agentFields = $('agent-fields');
const agentSave = $('agent-save');
const DEFAULT_AGENT_MODEL = 'deepseek-v4-flash';

if (agentEnabled && agentFields && agentSave) {
  const agentProvider = $('agent-provider');
  const agentCapabilityMode = $('agent-capability-mode');
  const agentApprovalTier = $('agent-approval-tier');
  const agentCapabilityNote = $('agent-capability-note');
  const agentBaseUrl = $('agent-base-url');
  const agentBaseUrlNote = $('agent-base-url-note');
  const agentApiKey = $('agent-api-key');
  const agentApiKeyNote = $('agent-api-key-note');
  const agentApiKeyClear = $('agent-api-key-clear');
  const agentApiKeyEnv = $('agent-api-key-env');
  const agentPluginPatch = $('agent-plugin-patch');
  const agentAdvanced = $('agent-advanced');
  const agentModel = $('agent-model');
  const agentModelLabel = $('agent-model-label');
  const agentModelSelect = $('agent-model-select');
  const agentModelSelectWrap = $('agent-model-select-wrap');
  const agentModelToggle = $('agent-model-toggle');
  const agentFetchBtn = $('agent-fetch-models');
  const agentModelsStatus = $('agent-models-status');

  const DEEPSEEK_OFFICIAL_URL = 'https://api.deepseek.com';
  // GET /api/settings 附带的三个只读派生字段（buildSettingsView()，
  // src/routes/settings.js）——key 是否已可用/来自哪里/掩码，从不含明文。
  // 保存前端本轮读到的这份快照，供「留空提交表示不修改」与「env 时禁用输入
  // 框」两条逻辑复用，不重新发请求判断。
  let keySnapshot = { configured: false, source: 'none', masked: null };

  const syncAgentCollapse = () => { agentFields.hidden = !agentEnabled.checked; };
  agentEnabled.addEventListener('change', syncAgentCollapse);

  // 供应商切换：deepseek-official 自动带出官方地址且锁定为只读（用户不可编辑，
  // 设计 1）；切到 openai-completions 时，若当前值仍是刚才自动填入的官方地址
  // （用户还没自己改过），清空好让用户填自己的端点，不留一个看似自定义、实际
  // 是残留官方地址的误导值。
  function applyProviderUI(provider) {
    const isOfficial = provider === 'deepseek-official';
    if (isOfficial) {
      agentBaseUrl.value = DEEPSEEK_OFFICIAL_URL;
    } else if (agentBaseUrl.value.trim() === DEEPSEEK_OFFICIAL_URL) {
      agentBaseUrl.value = '';
    }
    agentBaseUrl.readOnly = isOfficial;
    agentBaseUrlNote.hidden = !isOfficial;
  }
  agentProvider.addEventListener('change', () => {
    applyProviderUI(agentProvider.value);
    // 【2026-08-23 三次复审修复】切换 provider 必须重新算一遍 key 输入框
    // 的禁用态——见下面 applyKeyUI() 里 envLocksInput 的注释：这条规则现在
    // 跟 provider 有关，不能只在设置页首次加载时算一次。
    applyKeyUI();
  });

  function syncCapabilityNote() {
    agentCapabilityNote.textContent = agentCapabilityMode.value === 'full'
      ? '完整档启用上游 shell/jobs/web/subagent/workflow/Ralph。文件与命令仍受真实沙箱限制在本案；沙箱不可用时服务端拒绝启动，联网查询会发送给相应服务。切换档位会停止现有助理会话。'
      : '案件项目档可读取本案文件；文件工具不能越出案件夹，且不启用命令执行与联网搜索。';
  }
  agentCapabilityMode.addEventListener('change', syncCapabilityNote);

  // API Key 输入框的三种展示态（设计 2/3，keySource 三取值 env/stored/none，
  // 见 resolveAgentApiKey()）：env 时界面填写不生效、直接禁用输入框；stored
  // 时用掩码告知「已保存」并说明留空不修改；none 时纯提示。三种态都带上
  // 「保存在本机数据库并加密；能拿到数据目录的人可以解出来」这句如实说明——
  // 唯一例外是 env 态（那时界面存的 key 根本不生效，这句话对当前生效值无
  // 意义，只保留「界面填写不会覆盖」这句）。
  function applyKeyUI() {
    agentApiKey.value = '';
    // 「清除已保存的 key」只在 source==='stored' 时展示——这是唯一一种界面
    // 上能确认"本机数据库里存着一份密文、且它是当前真正生效的值"的状态。
    // env 态下输入框本身被禁用、界面填的值从不生效，清除操作没有立即可见
    // 的效果（即使底层可能还有一份被 env 遮住的历史存量密文，那是另一个更
    // 罕见的边界，这个按钮不覆盖）；none 态没有可清除的东西。
    agentApiKeyClear.hidden = keySnapshot.source !== 'stored';
    const provider = agentProvider.value;
    // 【2026-08-23 三次复审修复·可用性回归】此前不论 provider 是什么，
    // source==='env' 一律禁用输入框——但 POST /api/agent/models 对
    // openai-completions 从不提供"留空回落到 env/已存 key"这条路径（baseURL
    // 客户端可写，红线见 src/routes/agent.js 顶部注释），只有 deepseek-
    // official 才允许省略 apiKey。也就是说 openai-completions + env 来源
    // 这个组合下，如果继续禁用输入框，用户在这个 provider 下就永远没有任何
    // 入口能填出"仅用于本次测试拉取、不保证持久化"的一次性 key——「拉取
    // 可用模型」这个按钮对这类用户 100% 是死胡同（复审探针实测复现）。所以
        // 禁用输入框这条规则现在只在 deepseek-official 下才成立（它本来就
    // 允许留空回落，禁用输入框只是如实说明"这里填了也不会覆盖运行时生效的
    // 那份 env key"）。
    const envLocksInput = keySnapshot.source === 'env' && provider === 'deepseek-official';
    if (envLocksInput) {
      agentApiKey.disabled = true;
      agentApiKey.placeholder = '由环境变量提供';
      agentApiKeyNote.textContent = '当前由环境变量提供，界面填写不会覆盖。';
    } else if (keySnapshot.source === 'env') {
      // openai-completions + env：输入框必须可用，如实说明"填了也不会覆盖
      // 运行时生效的 env key，只用于这次拉取模型测试"。
      agentApiKey.disabled = false;
      agentApiKey.placeholder = '仅用于本次拉取模型测试，不影响运行时生效的环境变量 key';
      agentApiKeyNote.textContent = '当前运行时由环境变量提供 key；该供应商拉取模型必须显式填写一次 key（不会保存、也不会覆盖环境变量，仅用于本次测试）。';
    } else if (keySnapshot.configured) {
      agentApiKey.disabled = false;
      agentApiKey.placeholder = `已保存（末四位 ${keySnapshot.masked || ''}）`;
      agentApiKeyNote.textContent = '留空提交表示不修改已保存的 key。保存在本机数据库并加密；能拿到数据目录的人可以解出来。';
    } else {
      agentApiKey.disabled = false;
      agentApiKey.placeholder = 'sk-…';
      agentApiKeyNote.textContent = '尚未配置。保存在本机数据库并加密；能拿到数据目录的人可以解出来。';
    }
    updateFetchGate();
  }

  // 「清除已保存的 key」（2026-08-23 复审新增）：此前界面只有「留空提交表示
  // 不修改」这一条路径，没有任何入口能把本机保存的加密 key 真正删掉——
  // 保存分支只在输入框非空时才带上 agent_api_key，永远不会发出触发后端
  // 「清空」信号的空字符串。这里直接调一次独立的 PUT（不依赖用户先在输入框
  // 里清空、再点主保存按钮那条容易被忽略的隐式路径），带上空字符串——与
  // src/routes/settings.js 的 validateAgentFields() 既有的"空字符串=显式
  // 清空信号"完全同源，不是新协议。
  agentApiKeyClear.addEventListener('click', async () => {
    if (!confirm('清除本机保存的 API Key？清除后需要重新填写才能使用（除非改用环境变量）。')) return;
    agentApiKeyClear.disabled = true;
    try {
      const s = await api('/settings', { method: 'PUT', body: { agent_api_key: '' } });
      keySnapshot = {
        configured: !!s.agent_api_key_configured,
        source: s.agent_api_key_source || 'none',
        masked: s.agent_api_key_masked || null,
      };
      applyKeyUI();
      toast('已清除本机保存的 API Key');
    } catch (e) {
      toast('清除失败：' + (e.message || e));
    } finally {
      agentApiKeyClear.disabled = false;
    }
  });

  // 拉取模型成功后把 Model 从手填 input 切到下拉 select（保留手填入口作为
  // 兜底，设计 4）；点「改手动填写」切回去，并把 select 当前选中值带回 input，
  // 不丢用户已经选定的模型。选项列表/默认选中项的计算规则本身（含 2026-08-23
  // 复审修复的"外来旧值不能冒充默认选中项"这条红线）拆到不依赖 DOM 的纯函数
  // buildModelOptions()（./agent-model-options.js），单元测试见
  // tools/test-agent-model-options.js——这里只负责把它的结果画进 DOM。
  function showModelSelect(models, preferValue) {
    agentModelSelect.innerHTML = '';
    const { options, selected } = buildModelOptions(models, preferValue);
    for (const { value, label } of options) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      agentModelSelect.appendChild(opt);
    }
    if (selected != null) agentModelSelect.value = selected;
    agentModelLabel.hidden = true;
    agentModelSelectWrap.hidden = false;
    agentModelToggle.hidden = false;
  }
  function showModelManual() {
    if (!agentModelSelectWrap.hidden && agentModelSelect.value) agentModel.value = agentModelSelect.value;
    agentModelLabel.hidden = false;
    agentModelSelectWrap.hidden = true;
    agentModelToggle.hidden = true;
  }
  agentModelToggle.addEventListener('click', showModelManual);

  // 当前生效的 model 值：select 可见时以 select 为准，否则以手填 input 为准
  // ——两者只有一个在同一时刻代表用户的选择。
  function currentModelValue() {
    return agentModelSelectWrap.hidden ? agentModel.value.trim() : agentModelSelect.value.trim();
  }

  // 【2026-08-23 三次复审新增】POST /api/agent/models 对 openai-completions
  // 一律要求请求体显式带 apiKey（不提供任何"留空回落"，见 src/routes/agent.js
  // 顶部注释与错误码 api_key_required_for_custom_provider）；只有
  // deepseek-official 才允许留空回落到已保存/环境变量的 key。此前前端没有
  // 跟着这条红线收紧同步调整,导致"已保存 key/env 来源 key + openai-
  // completions"这两条最常见的路径点「拉取可用模型」必然先打一次注定 400
  // 的请求（复审探针实测复现）。这里在请求发出之前就地拦截、把按钮置灰,
  // 不再依赖等服务端拒绝之后才提示。
  //
  // gateHintShown 用来区分"当前显示的是本函数自己写的这条门禁提示"还是
  // "一次真实拉取的成功/失败结果"——只有前者允许在条件解除时被本函数清掉,
  // 避免"用户刚看到拉取成功的提示,切换一下 provider 又切回来,提示却被
  // 无条件抹掉"这种误伤。
  let gateHintShown = false;
  function updateFetchGate() {
    const provider = agentProvider.value;
    const needsExplicitKey = provider !== 'deepseek-official';
    const hasKeyInput = agentApiKey.value.trim().length > 0;
    const blocked = needsExplicitKey && !hasKeyInput;
    agentFetchBtn.disabled = blocked;
    if (blocked) {
      agentModelsStatus.hidden = false;
      agentModelsStatus.classList.remove('is-error');
      agentModelsStatus.textContent = '该供应商的 baseURL 可由界面随时修改，出于安全考虑拉取模型前必须先在上方填写一次 API Key（不会自动使用已保存/环境变量里的 key，也不会因为这次填写而覆盖它们，除非你另外点击保存）。';
      gateHintShown = true;
    } else if (gateHintShown) {
      agentModelsStatus.hidden = true;
      gateHintShown = false;
    }
  }
  agentApiKey.addEventListener('input', updateFetchGate);

  agentFetchBtn.addEventListener('click', async () => {
    const provider = agentProvider.value;
    const keyInput = agentApiKey.value.trim();
    if (provider !== 'deepseek-official' && !keyInput) {
      // 双保险：正常情况下这里应该已经被 updateFetchGate() 置灰、点不到；
      // 这一行只防御"按钮状态与实际输入不同步"的边界（例如浏览器自动填充
      // 触发的变更没有派发 input 事件）。
      updateFetchGate();
      return;
    }
    agentFetchBtn.disabled = true;
    agentModelsStatus.hidden = true;
    agentModelsStatus.classList.remove('is-error');
    gateHintShown = false;
    try {
      const body = { provider, baseURL: agentBaseUrl.value.trim() };
      // deepseek-official 下留空表示回落到已保存/环境变量的 key（与
      // loadAgentConfig() 同源，见 src/routes/agent.js 顶部注释）；
      // openai-completions 下上面的判断已经保证 keyInput 非空，这里两个
      // provider 共用同一行逻辑即可。
      if (keyInput) body.apiKey = keyInput;
      const result = await api('/agent/models', { method: 'POST', body });
      const preferValue = currentModelValue();
      showModelSelect(result.models || [], preferValue);
      agentModelsStatus.hidden = false;
      agentModelsStatus.textContent = `拉取成功，共 ${(result.models || []).length} 个模型`;
    } catch (e) {
      // api() 已经弹过一次 toast；这里额外把同一条服务端中文错误原样贴在
      // 按钮旁边，避免用户错过一闪而过的 toast（设计 4「失败时展示后端返回
      // 的中文错误」）。
      agentModelsStatus.hidden = false;
      agentModelsStatus.classList.add('is-error');
      agentModelsStatus.textContent = e.message || '拉取模型列表失败';
      // 【2026-08-23 UX 缺陷修复回归，编排方人工验收发现】拉取失败时必须
      // 自动露出手填入口，不能让用户困在"下拉框还是上一次成功时的旧列表、
      // 手填框却被折叠"这个状态里——首次拉取就失败时手填框本来就是默认可
      // 见的（profile.html 里 agent-model-label 默认不带 hidden），这里
      // 单独处理的是"已经成功过一次、切换 provider/改了 key 后再次拉取却
      // 失败"这条路径：此时下拉框仍在显示，仅有一枚「改手动填写」按钮可以
      // 点回手填，不是自动露出。复用既有的 showModelManual()（与用户手动
      // 点「改手动填写」完全同一套逻辑，同样会把下拉框当前选中值带回手填
      // 输入框，不丢用户已经选定的模型）。
      if (!agentModelSelectWrap.hidden) showModelManual();
    } finally {
      // 不是无条件 disabled = false——如果此时仍然满足"该 provider 需要
      // 显式 key 但输入框恰好又是空的"（例如用户在请求进行中把刚才填的
      // key 清空了），必须继续保持置灰，不能无条件解锁。
      updateFetchGate();
    }
  });

  api('/settings').then((s) => {
    agentEnabled.checked = s.agent_enabled === 'true';
    agentCapabilityMode.value = s.agent_capability_mode || 'project';
    agentApprovalTier.value = s.agent_approval_tier || '1';
    syncCapabilityNote();
    const provider = s.agent_provider || 'deepseek-official';
    agentProvider.value = provider;
    agentModel.value = s.agent_model || DEFAULT_AGENT_MODEL;
    if (s.agent_base_url != null) agentBaseUrl.value = s.agent_base_url;
    if (s.agent_api_key_env != null) agentApiKeyEnv.value = s.agent_api_key_env;
    if (s.agent_plugin_patch != null) agentPluginPatch.value = s.agent_plugin_patch;
    applyProviderUI(provider);
    keySnapshot = {
      configured: !!s.agent_api_key_configured,
      source: s.agent_api_key_source || 'none',
      masked: s.agent_api_key_masked || null,
    };
    applyKeyUI();
    // 高级选项默认收起（设计 5）；已经存在一个变量名时自动展开，免得用户
    // 看不到「输入框被 env 锁死」这件事究竟是为什么。
    if (agentApiKeyEnv.value.trim() || agentPluginPatch.value.trim()) agentAdvanced.open = true;
    syncAgentCollapse();
  }).catch(() => { applyKeyUI(); syncAgentCollapse(); /* 读不到就按关闭态展示，不拦着用户填 */ });

  agentSave.addEventListener('click', async () => {
    agentSave.disabled = true;
    try {
      // 关闭时只提交 agent_enabled 一个键——其余字段这时已经折叠，大概率
      // 还是空值；服务端对「body 里没出现这个键」完全放行（未涉及的键不校验、
      // 不改写），但对「出现了却是空字符串」会 400（如 agent_model 不能为
      // 空）。不分支的话，「勾选又立刻取消、从没填过字段就点保存」这类最简单
      // 的关闭操作会被一条跟「关闭」本身无关的校验错误拦住。
      let body;
      if (agentEnabled.checked) {
        body = {
          agent_enabled: true,
          agent_capability_mode: agentCapabilityMode.value,
          agent_approval_tier: agentApprovalTier.value,
          agent_provider: agentProvider.value,
          agent_model: currentModelValue(),
          agent_base_url: agentBaseUrl.value.trim(),
          agent_api_key_env: agentApiKeyEnv.value.trim(),
          agent_plugin_patch: agentPluginPatch.value.trim(),
        };
        // API Key：留空提交表示不修改（设计 2）——不在 body 里出现这个键，
        // 服务端 validateAgentFields() 对「未触及的键」完全不改写。只有
        // 输入框未被 env 禁用、且用户确实填了非空值时才带上。
        const keyInput = agentApiKey.value.trim();
        if (!agentApiKey.disabled && keyInput) body.agent_api_key = keyInput;
      } else {
        body = { agent_enabled: false };
      }
      const s = await api('/settings', { method: 'PUT', body });
      keySnapshot = {
        configured: !!s.agent_api_key_configured,
        source: s.agent_api_key_source || 'none',
        masked: s.agent_api_key_masked || null,
      };
      applyKeyUI();
      toast('AI 助理设置已保存');
    } catch (e) {
      toast('保存失败：' + (e.message || e));
    } finally {
      agentSave.disabled = false;
    }
  });
}

/* ── 退出会话（顶栏那枚图标按钮的显式副本；用裸 fetch，api() 会在 401 上抢先跳转） ── */
const logoutBtn = $('logout-btn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    logoutBtn.disabled = true;
    try { await fetch('/api/logout', { method: 'POST' }); } catch { /* 网络挂了也照样回登录页 */ }
    location.href = '/login.html';
  });
}

/* ── 关于：版本 / 规则条数 / 事件词表大小实时读，一律不写死 ──
   版本单一事实源 = package.json（服务端 /api/meta 透出）。手抄过两次都抄错，不再抄。 */
api('/meta').then((m) => {
  const rules = $('sys-rules');
  const events = $('sys-events');
  const vBadge = $('ver-badge');
  const vFull = $('ver-full');
  if (rules) rules.textContent = `${m.deadline_rules.length} 条`;
  if (events) events.textContent = `${m.event_types.length} 种`;
  if (vBadge) vBadge.textContent = 'v' + m.version;
  if (vFull) vFull.textContent = `案齐 anjian v${m.version}`;
}).catch(() => {
  const vFull = $('ver-full');
  if (vFull) vFull.textContent = '版本读取失败';
});
