// 顶栏（7 导航 + 皮肤三键 + counts + 退出 + 移动端汉堡）+ 底部快录条
// DOM 契约见 css/style.css 层 A 的 .topnav / .quickbar 段——改这里必须对着那里改。
import { api, el, toast } from './api.js';
import { iconEl } from './icons.js';
import { initSkinSwitcher } from './skin.js';

// 顺序按 DESIGN-TOKENS §10 A-2：今日 / 案件 / 日历 / 费用 / 修复 / 统计 / 用户中心
const LINKS = [
  ['/', '今日', 'today'],
  ['/cases.html', '案件', 'cases'],
  ['/calendar.html', '日历', 'calendar'],
  ['/fees.html', '费用', 'wallet'],
  ['/share-repairs.html', '修复', 'check'],
  ['/stats.html', '统计', 'stats'],
  ['/profile.html', '用户中心', 'user'],
];

// 皮肤三键：专业(亮·默认) · 纸感(亮) · 翡翠(暗)。
// auto 不占键位——它由「未设置 data-skin」表达，切到 auto 走 profile 页的皮肤卡。
const SKIN_KEYS = [
  ['pro',   '专业', '专业：亮色扁平，等宽数字'],
  ['paper', '纸感', '纸感：暖白纸底，衬线排印'],
  ['jade',  '翡翠', '翡翠：暗色毛玻璃，衬线大数字'],
];

// 顶栏导航 = 纯文字（图标只留给移动端下拉：纵向菜单里图标才是有效的扫读辅助）
function navLink(href, label, path, ic) {
  return el('a', {
    href,
    class: href === path ? 'active' : '',
    'aria-current': href === path ? 'page' : undefined,
  }, ic ? iconEl(ic) : null, label);
}

export async function mountNav() {
  let path = location.pathname === '/index.html' ? '/' : location.pathname;
  if (path === '/case.html') path = '/cases.html';   // 案件详情归组高亮「案件」

  const hamburger = el('button', { class: 'hamburger', 'aria-label': '菜单', 'aria-expanded': 'false' }, iconEl('menu'));
  const dropdown = el('div', { class: 'nav-dropdown' },
    LINKS.map(([href, label, ic]) => navLink(href, label, path, ic))
  );
  const versionBadge = el('span', { class: 'ver' });

  const nav = el('nav', { class: 'topnav' },
    hamburger,
    el('a', { class: 'brand', href: '/' },
      el('span', { class: 'seal', 'aria-hidden': 'true' }, '齐'),
      el('b', {}, '案齐'),
      versionBadge
    ),
    el('div', { class: 'links' },
      LINKS.map(([href, label]) => navLink(href, label, path))
    ),
    el('div', { class: 'spacer' }),
    el('div', { class: 'skins', role: 'group', 'aria-label': '主题皮肤切换' },
      SKIN_KEYS.map(([value, label, title]) => el('button', {
        class: 'sk',
        type: 'button',
        'data-skin-value': value,
        'aria-pressed': 'false',   // 真值由 skin.js 接管（auto 时点亮实际生效的那枚）
        title,
      }, label))
    ),
    el('span', { class: 'navbadge counts', id: 'nav-counts' }),
    el('button', {
      class: 'iconbtn', 'aria-label': '退出登录', title: '退出登录',
      onclick: async () => {
        await fetch('/api/logout', { method: 'POST' });
        location.href = '/login.html';
      },
    }, iconEl('logout')),
    dropdown
  );

  document.body.prepend(nav);
  initHamburger(hamburger, dropdown);
  initSkinSwitcher(nav);   // 皮肤切换器不依赖网络：先把 UI 立起来，再去拉数据
  mountQuickbar();

  // counts 只是徽标——用 .then 不用 await，别让顶栏和整页渲染陪着网络一起等
  api('/counts').then((c) => {
    if (c.version) versionBadge.textContent = `v${c.version}`;
    // 快录条的「整理」按钮：服务端配了 DEEPSEEK_API_KEY 才亮出来（搭 counts 顺风车，零额外请求）
    const tidy = document.querySelector('.quickbar .btn.ghost');
    if (tidy && c.llm) tidy.hidden = false;
    const badge = document.getElementById('nav-counts');
    if (!badge) return;
    badge.append(`在办 ${c.active_cases} · 收件箱 `);
    badge.append(
      c.inbox_pending > 0
        ? el('span', { class: 'badge-dot' }, String(c.inbox_pending))
        : '0'
    );
  }).catch(() => { /* counts 失败不阻塞页面 */ });
}

// 移动端汉堡菜单：展开/收起 + 外点关闭 + Escape 关闭 + 点链接自收
function initHamburger(hamburger, dropdown) {
  hamburger.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = dropdown.classList.toggle('open');
    hamburger.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target) && !hamburger.contains(e.target)) {
      dropdown.classList.remove('open');
      hamburger.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      dropdown.classList.remove('open');
      hamburger.setAttribute('aria-expanded', 'false');
    }
  });
  dropdown.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      dropdown.classList.remove('open');
      hamburger.setAttribute('aria-expanded', 'false');
    });
  });
}

function mountQuickbar() {
  const kind = el('select', { 'aria-label': '快录类型' },
    el('option', { value: 'task' }, '记待办'),
    el('option', { value: 'log' }, '记日志')
  );
  const caseSel = el('select', { 'aria-label': '挂到案件' }, el('option', { value: '' }, '（不挂案件）'));
  const text = el('input', { type: 'text', placeholder: '一句话快录……', required: '', 'aria-label': '快录内容' });
  const date = el('input', { type: 'date', 'aria-label': '日期（可选）' });
  const tidyBtn = el('button', {
    class: 'btn ghost small', type: 'button', title: '让 LLM 把这句话整理成类型/案件/日期（只填表，不入库）',
  }, '整理');
  const HINT_DEFAULT = '捕捉零摩擦：先记下，晚点再整理';
  const hint = el('span', { class: 'hint' }, HINT_DEFAULT);
  const bar = el('div', { class: 'quickbar' },
    el('form', {
      class: 'qbin',   // CSS 同时匹配 .quickbar > form 与 .quickbar .qbin
      onsubmit: async (e) => {
        e.preventDefault();
        if (!text.value.trim()) return;
        const body = { kind: kind.value, text: text.value.trim() };
        if (caseSel.value) body.case_id = Number(caseSel.value);
        if (date.value) body.date = date.value;
        const r = await api('/quick', { body });
        toast(r.kind === 'task' ? '已记待办 ✓' : '已记日志 ✓');
        text.value = '';
        // 记完了：AI 那条「已整理」提示随之作废——别把旧结论留在空白输入框旁边
        hint.textContent = HINT_DEFAULT;
        hint.classList.remove('hint-ai');
        document.dispatchEvent(new CustomEvent('anjian:changed'));
      },
    }, kind, caseSel, text, date, tidyBtn,
      el('button', { class: 'btn primary', type: 'submit' }, '记'),
      hint
    )
  );
  document.body.appendChild(bar);

  // ── LLM 整理（1.1.0）：把一句话填进上面这几个框，**不写库**——人按「记」才入表 ──
  // 未配 key 时不渲染按钮（下面 /counts 的 llm 标志决定），所以这里默认先藏着。
  tidyBtn.hidden = true;
  tidyBtn.addEventListener('click', async () => {
    const raw = text.value.trim();
    if (!raw) { text.focus(); return; }
    tidyBtn.disabled = true;
    const old = tidyBtn.textContent;
    tidyBtn.textContent = '整理中…';
    try {
      const s = await api('/quick/parse', { body: { text: raw } });
      kind.value = s.kind;
      text.value = s.title;
      if (s.date) date.value = s.date;
      if (s.case_id) caseSel.value = String(s.case_id);
      // 说清楚它做了什么、没做到什么——人要在按「记」之前一眼看出该不该改
      const bits = [s.kind === 'log' ? '日志' : '待办'];
      if (s.case_name) bits.push(s.case_name);
      else if (s.case_hint) bits.push(`案件没认出「${s.case_hint}」，请自己选`);
      if (s.date) bits.push(s.date);
      else bits.push('未提日期');
      hint.textContent = `已整理：${bits.join(' · ')} —— 核对无误按「记」`;
      hint.classList.add('hint-ai');
    } catch (e) {
      // 上游挂了/没配 key：不挡录入，原文原样留在框里，照样能手动「记」
      hint.textContent = /503/.test(e.message) ? '未配置 LLM，手动录入不受影响' : `整理失败：${e.message}`;
      hint.classList.remove('hint-ai');
      if (/503/.test(e.message)) tidyBtn.remove();
    } finally {
      tidyBtn.disabled = false;
      tidyBtn.textContent = old;
    }
  });
  // 人一改内容，AI 那句提示就作废——别让旧结论挂在新输入旁边
  for (const f of [text, kind, caseSel, date]) {
    f.addEventListener('input', () => {
      if (!hint.classList.contains('hint-ai')) return;
      hint.textContent = HINT_DEFAULT;
      hint.classList.remove('hint-ai');
    });
  }
  // 窄屏快录条折行增高时自适应底部净空，避免遮挡末尾卡片（基准 128px 不变）
  new ResizeObserver(() => {
    document.body.style.paddingBottom = Math.max(128, bar.offsetHeight + 28) + 'px';
  }).observe(bar);
  api('/cases?status=active').then((cases) => {
    for (const c of cases) caseSel.append(el('option', { value: c.id }, c.name));
    // 案件详情页：快录默认挂当前案件——人在本案页记的东西几乎一定是本案的（DESIGN.md §8.6）
    if (location.pathname === '/case.html') {
      const cid = new URLSearchParams(location.search).get('id');
      if (cid) caseSel.value = cid;
    }
  }).catch(() => {});
}
