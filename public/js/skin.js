// 皮肤状态机：pro | paper | jade | auto —— 取代已删除的 theme.js 三态状态机。
// 新代码一律 import 本模块。
//
// 与 css/style.css 层 B 的契约（改任一侧都要同步另一侧）：
//   · 显式皮肤 → <html data-skin="pro|paper|jade">
//   · auto     → **移除** data-skin 属性。暗/亮的判定交给 CSS 的
//                @media (prefers-color-scheme: dark) —— OS 暗回落 jade 全套令牌，
//                OS 亮则 :root（= pro）令牌生效。JS 不代 CSS 做这个决定，
//                只负责 CSS 够不着的三件事：meta[theme-color] / color-scheme / 切换器高亮。
//   · localStorage 键 anjian-skin；旧键 anjian-theme 读到即迁移并删除。
//
// jade 是暗色主题本体——本系统不再有独立的 light/dark 开关，三选一即主题选择。

const KEY = 'anjian-skin';
const OLD_KEY = 'anjian-theme';

export const SKINS = ['pro', 'paper', 'jade', 'auto'];

/** 各皮肤的 --bg-base 实际值（对齐 style.css 层 B；改 CSS 底色记得同步这里） */
const BG = { pro: '#F6F7F8', paper: '#F4EFE3', jade: '#050D0A' };

/** 旧三态 → 新皮肤。亮=专业、暗=翡翠（jade 就是暗色皮肤），auto 原样保留。 */
const LEGACY = { light: 'pro', dark: 'jade', auto: 'auto' };

const DARK_MQ = matchMedia('(prefers-color-scheme: dark)');
const bound = new WeakSet();   // 防重复绑定（initSkinSwitcher 可能被调多次）
let transTimer = 0;

// localStorage 在隐私模式 / 禁 Cookie 下会抛——皮肤是装饰，绝不能因此炸掉整页
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* noop */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch { /* noop */ } }

/**
 * 读偏好，并就地迁移旧键。
 * 与 9 页 <head> 内联防闪烁脚本同逻辑——两处谁先跑都得到同一结果（幂等）。
 * 脏值（历史污染的 "undefined" / 直写的 light|dark）一律回落 auto，杜绝 data-skin="light" 这种非法值。
 */
export function getSkin() {
  let v = lsGet(KEY);
  if (!v) {
    const old = lsGet(OLD_KEY);
    if (old !== null) {
      v = LEGACY[old] || 'auto';
      lsSet(KEY, v);
      lsDel(OLD_KEY);
    }
  }
  return SKINS.includes(v) ? v : 'auto';
}

/** 偏好落地成真正生效的皮肤（auto → 跟随 OS） */
export function getResolvedSkin() {
  const pref = getSkin();
  return pref === 'auto' ? (DARK_MQ.matches ? 'jade' : 'pro') : pref;
}

/** 把偏好同步到 DOM。不写 localStorage、不加过渡类——纯投影。 */
function apply(pref) {
  const root = document.documentElement;
  const resolved = pref === 'auto' ? (DARK_MQ.matches ? 'jade' : 'pro') : pref;

  if (pref === 'auto') root.removeAttribute('data-skin');
  else root.setAttribute('data-skin', pref);

  // 原生控件配色（快录条的 <input type=date> / <select> / 滚动条）——CSS 里没有 color-scheme，
  // 不设的话 jade 暗底上会弹出一个亮色系统日期选择器。auto 交回 UA 自己跟随 OS。
  root.style.colorScheme = pref === 'auto' ? 'light dark' : (resolved === 'jade' ? 'dark' : 'light');

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', BG[resolved]);

  syncSwitchers(pref, resolved);
}

/**
 * 同步所有切换 UI。
 * · 顶栏 .sk 三键：按 **resolved** 高亮——auto 时没有第四个键位，
 *   点亮「当前实际生效」的那枚才是诚实的（aria-pressed = 该皮肤正生效）。
 * · profile 皮肤卡 .theme-card：按 **pref** 高亮——那里有 auto 卡，选的是偏好本身。
 *   同时吃新属性 data-skin-value 与旧属性 data-theme-value（旧 profile.html 尚未改造）。
 */
function syncSwitchers(pref, resolved) {
  document.querySelectorAll('.sk').forEach((btn) => {
    const on = btn.dataset.skinValue === resolved;
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('on', on);
    const base = btn.dataset.skinTitle || btn.getAttribute('title') || '';
    if (!btn.dataset.skinTitle && base) btn.dataset.skinTitle = base;   // 首次记下原始 title
    if (base) btn.setAttribute('title', on && pref === 'auto' ? base + '（当前跟随系统）' : base);
  });

  document.querySelectorAll('.theme-card').forEach((card) => {
    const raw = card.dataset.skinValue || card.dataset.themeValue;
    const val = LEGACY[raw] || raw;
    const on = val === pref;
    card.classList.toggle('selected', on);
    card.setAttribute('aria-pressed', String(on));
  });
}

/** 切皮肤（用户动作）：写盘 + 300ms 交叉淡入 + 落地 DOM。旧值（light/dark）也吃。 */
export function setSkin(v) {
  const pref = SKINS.includes(v) ? v : (LEGACY[v] || 'auto');
  const root = document.documentElement;

  // CSS: html.skin-transitioning —— prefers-reduced-motion 下 CSS 自己会禁掉过渡，这里无需判断
  root.classList.add('skin-transitioning');
  clearTimeout(transTimer);
  transTimer = setTimeout(() => root.classList.remove('skin-transitioning'), 300);

  lsSet(KEY, pref);
  lsDel(OLD_KEY);   // 迁移收尾：任何一次显式切换都顺手清掉旧键
  apply(pref);
}

/**
 * 绑定切换器并同步一次当前状态。
 * container 缺省为 document；顶栏在 nav.js 里传 nav 元素。
 * 首帧不加过渡类：<head> 内联脚本已把皮肤铺好，这里只补 JS 侧的 UI 同步。
 */
export function initSkinSwitcher(container = document) {
  container.querySelectorAll('.sk').forEach((btn) => {
    if (bound.has(btn)) return;
    bound.add(btn);
    btn.addEventListener('click', () => setSkin(btn.dataset.skinValue));
  });
  apply(getSkin());
}

// OS 配色变化：auto 时实时跟随。data-skin 依旧不设——真正的换肤由 CSS 媒体查询完成，
// 这里只补 theme-color / color-scheme / 三键高亮。
DARK_MQ.addEventListener('change', () => {
  if (getSkin() === 'auto') apply('auto');
});

// 跨标签页同步：在另一个标签里换了皮肤，本标签跟着变
window.addEventListener('storage', (e) => {
  if (e.key === KEY || e.key === OLD_KEY) apply(getSkin());
});
