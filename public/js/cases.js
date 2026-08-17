// 案件列表：按程序分组的案件卡网格 + 状态/关键词筛选 + 新建案件（details.adder）。
// DOM 契约（改这里必须对着 cases.html 改）：
//   静态 id —— #f-status #f-q #new-case(<details>) #new-case-form #nc-procedure #nc-stage
//              #subtitle(.page-sub) #case-list
//   建案表单靠 name 属性经 FormData 序列化，name 一个都不能改/丢。
import { api, el, toast, fmtDaysLeft, todayStr } from './api.js';
import { mountNav } from './nav.js';
import { miniStepper } from './charts.js';
import { bindFold } from './fold.js';

await mountNav();

const meta = await api('/meta');

// 新建案件表单：程序 → 阶段联动
const procSel = document.getElementById('nc-procedure');
const stageSel = document.getElementById('nc-stage');
for (const p of meta.procedures) procSel.append(el('option', { value: p }, p));
function syncStages() {
  stageSel.replaceChildren();
  for (const s of meta.stage_templates[procSel.value] || []) stageSel.append(el('option', { value: s }, s));
}
procSel.addEventListener('change', syncStages);
syncStages();

document.getElementById('new-case-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  const created = await api('/cases', { body });
  // 建案的下一步几乎一定是进详情录事件/期限——直接落过去，不让人回列表再找一遍
  location.href = `/case.html?id=${created.id}`;
});

// 搁置/已结的案子不追期限，底行改用静态状态签
const STATUS_PILL = { active: null, shelved: ['warn', '搁置'], closed: ['ok', '已结'] };

const daysUntil = (due) => Math.round((new Date(due) - new Date(todayStr())) / 86400000);

// 期限是本设计的母题：卡片底行让「剩 N 日」用 .days-left 领读——粗体 + 等宽/衬线数字 + 状态色，
// 而不是塞进一枚与「程序 · 阶段」等权的 chip 里。无在追期限 = 真实的健康警告（期限缺口），留琥珀签。
function deadlineEls(c) {
  if (!c.next_due) return [el('span', { class: 'pill warn' }, '无在追期限')];
  const d = daysUntil(c.next_due);
  const tone = d <= 3 ? 'crit' : d <= 7 ? 'warn' : '';
  return [
    el('span', { class: ('days-left ' + tone).trim() }, fmtDaysLeft(d)),
    el('span', { class: 'meta' }, `${c.next_due.slice(5)} 到期`),
  ];
}

function caseCard(c) {
  const sp = STATUS_PILL[c.status];
  const stale = c.status === 'active' && c.stage_days > 30;
  return el('a', { class: 'case-card', href: `/case.html?id=${c.id}` },
    el('span', { class: 'cname' }, c.name),
    el('span', { class: 'cmeta' },
      c.case_no ? el('span', { class: 'case' }, c.case_no) : el('span', {}, '未立案 · 案号待补'),
      c.court ? el('span', {}, c.court) : null,
      c.cause ? el('span', {}, c.cause) : null
    ),
    el('span', { class: 'cfoot' },
      miniStepper(meta.stage_templates[c.procedure] || [], c.stage),
      el('span', { class: 'pill acc' }, `${c.procedure} · ${c.stage}`),
      stale
        ? el('span', { class: 'pill warn' }, `停留 ${c.stage_days} 天`)
        : el('span', { class: 'meta' }, `停留 ${c.stage_days} 天`)
    ),
    el('span', { class: 'cfoot' },
      sp ? el('span', { class: `pill ${sp[0]}` }, sp[1]) : deadlineEls(c),
      el('span', { class: 'meta' }, `期限 ${c.pending_deadlines} · 待办 ${c.open_tasks}`)
    )
  );
}

async function load() {
  const status = document.getElementById('f-status').value;
  const q = document.getElementById('f-q').value.trim();
  // 默认视图（在办）拉全部：active 渲染为主体、shelved/closed 进归档门（规格 §03.D）。
  // 用户主动选特定状态时，只看那个状态，不叠归档门。
  const fetchStatus = status === 'active' ? '' : status;
  const params = new URLSearchParams();
  if (fetchStatus) params.set('status', fetchStatus);
  if (q) params.set('q', q);
  const cases = await api('/cases?' + params.toString());

  // 副题 = 当前视图的期限体检；0 值一律不出现（CRITIQUE 修复项 4「0 值降权」）
  let over = 0, soon = 0, gap = 0;
  for (const c of cases) {
    if (!c.next_due) {
      if (c.status === 'active') gap++;
      continue;
    }
    const d = daysUntil(c.next_due);
    if (d < 0) over++;
    else if (d <= 7) soon++;
  }
  const parts = [`${cases.length} 件`];
  if (over) parts.push(`${over} 件死线逾期`);
  if (soon) parts.push(`${soon} 件 7 日内到期`);
  if (gap) parts.push(`${gap} 件无在追期限`);
  document.getElementById('subtitle').textContent = parts.join(' · ');

  const box = document.getElementById('case-list');
  box.replaceChildren();
  if (!cases.length) {
    box.append(el('div', { class: 'panel' },
      el('div', { class: 'section-empty' },
        q ? `没有匹配「${q}」的案件` : '该状态下还没有案件——用上方「新建案件」建第一件')
    ));
    return;
  }

  // 在办案件按程序分组平铺（规格 §03.D：账本行，不折叠）；
  // 已结/搁置合并到表底一道归档门（只在"全部/在办"视图生效——用户主动筛"已结/搁置"时它们是主体）。
  const active = cases.filter((c) => c.status === 'active');
  const archived = cases.filter((c) => c.status === 'shelved' || c.status === 'closed');
  const showArchive = archived.length && (!status || status === 'active');

  const mainCases = showArchive ? active : cases;
  const groups = new Map();
  for (const c of mainCases) {
    if (!groups.has(c.procedure)) groups.set(c.procedure, []);
    groups.get(c.procedure).push(c);
  }
  for (const [proc, list] of groups) {
    box.append(el('div', { class: 'group-title case-procedure-title' },
      el('span', {}, proc),
      el('span', { class: 'count' }, `${list.length} 件`)
    ));
    box.append(el('div', { class: 'case-grid' }, list.map(caseCard)));
  }

  if (showArchive) {
    const shelvedN = archived.filter((c) => c.status === 'shelved').length;
    const closedN = archived.filter((c) => c.status === 'closed').length;
    const parts = [];
    if (closedN) parts.push(`已结 ${closedN} 件`);
    if (shelvedN) parts.push(`搁置 ${shelvedN} 件`);
    const archive = el('details', { class: 'archive-door cases-archive' },
      el('summary', { class: 'archive-door-summary' },
        el('span', { class: 'archive-door-caret' }, '▸'),
        el('span', { class: 'archive-door-text' }, '已结与搁置'),
        el('span', { class: 'archive-door-count' }, parts.join(' · ')),
      ),
      el('div', { class: 'archive-door-body' },
        el('div', { class: 'case-grid' }, archived.map(caseCard))
      ),
    );
    bindFold(archive, 'cases-archived', false);
    archive.addEventListener('toggle', () => {
      const caret = archive.querySelector('.archive-door-caret');
      if (caret) caret.textContent = archive.open ? '▾' : '▸';
    });
    box.append(archive);
  }
}

document.getElementById('f-status').addEventListener('change', load);
let timer;
document.getElementById('f-q').addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(load, 250);
});
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.key !== '/') return;
  const t = e.target;
  const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if (typing) return;
  e.preventDefault();
  document.getElementById('f-q').focus();
});
document.addEventListener('anjian:changed', load);
await load();
