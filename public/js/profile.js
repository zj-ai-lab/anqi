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
