// 今日看板（旗舰页）。骨架 = docs/design-directions/D-merged.html：
// 双栏工作台 + 期限跑道（头条巨字 → 紧凑行 → 今日/死线时间轴条）+ 右栏仪表窄栏。
//
// DOM 契约（index.html 里的容器 id，改任一侧都要同步另一侧）：
//   #title #subtitle #tiles #sec-inbox-card(原生 hidden) #inbox-meta #inbox-list
//   #h-runway>#runway-count #runway-meta #sec-runway
//   #h-tasks #tasks-meta #sec-tasks
//   #h-strip #strip-range #sec-strip
//   #h-hearings #hearings-meta #sec-hearings
//   #h-fees #fees-meta #sec-fees
//   #h-gap #sec-gap
// 卡片标题不再 prepend 图标（CRITIQUE 修复项 3「禁每标题配 icon」）——旧 H 循环已删。
import { api, el, toast, todayStr } from './api.js';
import { mountNav } from './nav.js';
import { strip14 } from './charts.js';
import { datePrompt } from './dateedit.js';
import { bindFold } from './fold.js';

await mountNav();
// 更远的待办 = 归档门（复用 fold.js 持久化 + caret 同步）
const alltasksDoor = document.getElementById('today-alltasks');
bindFold(alltasksDoor, 'today-alltasks', false);
alltasksDoor.addEventListener('toggle', () => {
  const caret = alltasksDoor.querySelector('.archive-door-caret');
  if (caret) caret.textContent = alltasksDoor.open ? '▾' : '▸';
});

// 期限缺口 = 事实条：「去补」就地展开缺口列表
const gapToggle = document.getElementById('today-gap-toggle');
const gapMore = document.getElementById('sec-gap');
if (gapToggle && gapMore) {
  gapToggle.addEventListener('click', () => {
    const open = gapMore.hasAttribute('hidden');
    if (open) gapMore.removeAttribute('hidden'); else gapMore.setAttribute('hidden', '');
    gapToggle.classList.toggle('is-active', open);
    gapToggle.setAttribute('aria-expanded', String(open));
    gapToggle.textContent = open ? '收起' : '去补';
  });
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const DAY = 86400000;

const caseLink = (id, name) => el('a', { href: `/case.html?id=${id}` }, name);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const wd = (iso) => WEEKDAYS[new Date(iso + 'T00:00:00Z').getUTCDay()];
const shift = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const diffD = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY);
const md = (iso) => iso.slice(5);
const yuan = (n) => '¥' + Number(n || 0).toLocaleString('zh-CN');
const m = (v) => el('span', { class: 'm' }, String(v));
const sep = () => el('span', {}, '·');   // .p-meta 里的间隔点（无 class，别和 .dot 色点混淆）

// 分档口径与 digest 分桶 / charts.js 一致：逾期 / ≤3 日 / 4–7 日 / 8–30 日
const bandOf = (days) => (days < 0 ? 'over' : days <= 3 ? 'crit' : days <= 7 ? 'warn' : 'ok');

// ── 时间轴条（跑道母题）──────────────────────────────────────────────
// 16 日刻度 = 逾期 2 日 + 未来 14 日；今日 = 原点 12.5%（.trk 的刻度线亦为 6.25%/格）。
// 逾期段自原点向左反向延伸；>14 日一律满格（数字与到期日列仍给精确值）。
const TRK_BACK = 2;
const TRK_SPAN = 16;
const ORIGIN = (TRK_BACK / TRK_SPAN) * 100;   // 12.5
const trkPos = (days) => clamp(((TRK_BACK + days) / TRK_SPAN) * 100, 0, 100);

function trkBar(d, band) {
  const over = band === 'over';
  const x = trkPos(d.days_left);
  const left = over ? x : ORIGIN;
  const width = Math.max(1.5, Math.abs(ORIGIN - x));   // 今日到期也留一小段可见
  const tip = over
    ? `逾期 ${-d.days_left} 天 —— 死线 ${d.due_on} 落在今日原点左侧`
    : `剩 ${d.days_left} 天 —— 今日到死线 ${d.due_on}`;
  return el('div', { class: 'rw-trk' },
    el('div', { class: 'trk', title: tip },
      // 动态百分比只能走内联 style（颜色一律由 class → var() 决定）
      el('i', { class: `trk-fill ${over ? 'over' : band}`, style: `left:${left}%;width:${width}%` }),
      el('i', { class: 'trk-origin' }),
      el('i', { class: `trk-dot ${over ? 'crit' : band}`, style: `left:${clamp(x, 1, 99)}%` })
    )
  );
}

// ── 期限跑道 ────────────────────────────────────────────────────────
function doneBtn(d) {
  return el('button', {
    class: 'btn small',
    type: 'button',
    'aria-label': `完成期限：${d.name}`,
    title: '标记为已完成',
    onclick: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await api(`/deadlines/${d.id}`, { method: 'PATCH', body: { status: 'done' } });
      toast('已完成 ✓');
      load();
    },
  }, '完成');
}

async function editDeadlineDue(d) {
  const v = await datePrompt({
    title: `改「${d.name}」截止日`,
    hint: '手动改期将标记为人工设定，级联重算默认不再覆盖它',
    fields: [{ key: 'due_on', label: '截止日', value: d.due_on, required: true }],
  });
  if (!v || v.due_on === d.due_on) return;
  await api(`/deadlines/${d.id}`, { method: 'PATCH', body: { due_on: v.due_on } });
  toast('截止日已改 ✓');
  load();
}

function deadlineActions(d, lead = false) {
  return el('span', { class: lead ? 'rw-key' : 'rw-acts' },
    el('button', {
      class: 'btn small', type: 'button', 'aria-label': `改期：${d.name}`,
      onclick: async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await editDeadlineDue(d);
      },
    }, '改期'),
    doneBtn(d)
  );
}

const rowTitle = (d) => `${d.case_name}｜${d.name}｜${d.due_on}${d.basis ? '｜' + d.basis : ''}`;

// 头条：最近的一条死线 = 全页最大的数字（SPEC 层级要求 ≥48px）
function leadRow(d) {
  const days = d.days_left;
  const band = bandOf(days);
  const tone = band === 'warn' ? ' amb' : band === 'ok' ? ' ok' : '';
  const kick = days < 0 ? '最近死线 · 已逾期' : days === 0 ? '最近死线 · 今日截止' : '最近死线';
  return el('article', { class: 'rw-lead' + tone, title: rowTitle(d) },
    el('div', { class: 'hd-main' },
      el('div', { class: 'hd-kick' }, kick),
      el('div', { class: 'hd-num' },
        el('span', { class: 'w' }, days < 0 ? '逾期' : '剩'),
        el('span', { class: 'n' }, String(Math.abs(days))),
        el('span', { class: 'w' }, '天')
      ),
      el('h3', { class: 'hd-deck' }, `${d.case_name}——${d.name}`),
      el('div', { class: 'hd-rule', 'aria-hidden': 'true' }),
      el('div', { class: 'hd-meta' },
        el('span', { class: 'case' }, `到期 ${d.due_on}（周${wd(d.due_on)}）`),
        d.basis ? el('span', { class: 'sep' }, '·') : null,
        d.basis ? el('span', {}, `依据 ${d.basis}`) : null,
        d.severity === 'critical' ? el('span', { class: 'chip c-red' }, '致命期限') : null
      )
    ),
    trkBar(d, band),
    el('div', { class: 'rw-due' }, md(d.due_on)),
    el('div', { class: 'focus-actions' },
      el('a', { class: 'btn primary', href: `/case.html?id=${d.case_id}` }, '打开案件处理'),
      deadlineActions(d, true)
    )
  );
}

// 紧凑行：字号梯度 28 → 20 → 15 由行序（急迫度排名）决定，是信息层级不是装饰
function compactRow(d, i) {
  const days = d.days_left;
  const band = bandOf(days);
  const size = i === 1 ? 'd1' : i === 2 ? 'd2' : 'd3';
  const tone = band === 'warn' ? ' amb' : band === 'ok' ? '' : ' crit';
  return el('article', { class: `rw-row ${size}${tone}`, title: rowTitle(d) },
    el('div', { class: 'rw-days' },
      el('span', { class: 'pre' }, days < 0 ? '逾期' : '剩'),
      el('span', { class: 'n' }, String(Math.abs(days))),
      el('span', { class: 'u' }, '天')
    ),
    el('a', { class: 'rw-main', href: `/case.html?id=${d.case_id}` },
      el('div', { class: 'm1' }, d.name),
      el('div', { class: 'm2' },
        el('span', {}, d.case_name),
        d.basis ? el('span', { class: 'sep' }, '·') : null,
        d.basis ? el('span', { class: 'case' }, d.basis) : null,
        d.severity === 'critical' ? el('span', { class: 'chip c-red' }, '致命') : null
      )
    ),
    trkBar(d, band),
    el('div', { class: 'rw-due' }, md(d.due_on)),
    deadlineActions(d)
  );
}

function runwayPanel(items) {
  const wrap = el('div', { class: 'runway runway-act' },
    el('div', { class: 'rw-colhead' },
      el('div', { class: 'h-days' }, '剩余'),
      el('div', { class: 'h-item' }, '事项 · 案件'),
      el('div', { class: 'h-trk' }, '跑道（今日 → 死线）'),
      el('div', { class: 'h-due' }, '到期'),
      el('div', { class: 'h-key' }, '操作')
    )
  );
  items.forEach((d, i) => wrap.append(compactRow(d, i + 1)));
  return wrap;
}

// ── 今日待办 ────────────────────────────────────────────────────────
function taskRow(t, today) {
  const overdue = !!t.due_on && t.due_on < today;
  const noDate = !t.due_on && !t.plan_date;
  const tail = t.due_on ? `截止 ${md(t.due_on)}` : (t.plan_date ? `计划 ${md(t.plan_date)}` : '');
  return el('div', { class: `todo-row${overdue ? ' is-overdue' : ''}` },
    el('label', { class: 'ck' },
      el('input', {
        type: 'checkbox',
        'aria-label': `完成：${t.title}`,
        onchange: async () => {
          const result = await api(`/tasks/${t.id}`, { method: 'PATCH', body: { status: 'done' } });
          toast(result.completion_worklog
            ? (result.case_id ? '已完成，已记入案件时间线 ✓' : '已完成，已记入工作日志 ✓')
            : '已完成 ✓');
          load();
        },
      }),
      el('span', { class: 'box' })
    ),
    el('span', { class: 't-text' },
      // U+26A0 + U+FE0E 强制文本变体：不是 emoji 图标
      overdue ? el('span', { class: 'warn-glyph', 'aria-hidden': 'true' }, '⚠︎') : null,
      t.title
    ),
    el('span', { class: 't-chips' },
      overdue ? el('span', { class: 'chip c-red' }, '已逾期') : null,
      t.priority === 'high' ? el('span', { class: 'chip c-amber' }, '优先') : null,
      t.origin === 'llm' ? el('span', { class: 'chip c-green' }, 'AI 建议') : null,
      t.case_name
        ? el('a', { class: 'chip mono', href: `/case.html?id=${t.case_id}`, title: t.case_name }, `挂 ${t.case_name}`)
        : el('span', { class: 'chip' }, '不挂案件')
    ),
    // 无日期待办（全部待办区的「未排期」项）标灰 chip；有日期的走 meta 文案
    noDate
      ? el('span', { class: 't-key' }, el('span', { class: 'chip' }, '未排期'))
      : (tail ? el('span', { class: 't-key' }, el('span', { class: 'meta' }, tail)) : null)
  );
}

// ── 收件箱 · 待裁决 ─────────────────────────────────────────────────
const INB = {
  event: ['疑似事件', 'chip c-blue'],
  deadline: ['疑似期限', 'chip c-amber'],
  task: ['疑似待办', 'chip'],
  note: ['疑似记录', 'chip'],
};

function inboxRow(i) {
  let p = {};
  try { p = JSON.parse(i.payload); } catch { /* noop */ }
  const desc = i.kind === 'task' ? p.title : i.kind === 'deadline' ? `${p.name} → ${p.due_on}` :
    i.kind === 'event' ? `${p.type} ${p.occurred_on}` : (p.content || p.text || '');
  const [label, cls] = INB[i.kind] || INB.note;
  return el('div', { class: 'inb-row' },
    el('span', { class: cls }, label),
    el('div', { class: 'inb-body' },
      el('div', { class: 'inb-q' }, desc ? `「${desc}」` : '（空）'),
      p.basis ? el('div', { class: 'inb-src' }, `依据：${p.basis}`) : null,
      i.change_summary ? el('div', { class: 'inb-src' }, `↻ ${i.change_summary}`) : null,
      el('div', { class: 'inb-src' }, `来源：${i.source}`, i.case_name ? ` · ${i.case_name}` : '',
        Number(i.seen_count || 1) > 1 ? ` · 周检重复命中 ${i.seen_count} 次，已合并` : '')
    ),
    el('div', { class: 'inb-acts' },
      el('button', {
        class: 'btn ok', type: 'button',
        onclick: async () => { await api(`/inbox/${i.id}/accept`, { body: {} }); toast('已采纳'); load(); },
      }, '采纳'),
      el('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          const v = await datePrompt({
            title: '稍后再看这条建议',
            hint: '到期后会唤回当前这张卡，不会另建一条重复建议。',
            fields: [
              { key: 'until', label: '重新提醒日期', value: shift(todayStr(), 7), type: 'date', required: true },
              { key: 'reason', label: '暂缓原因（可选）', value: '', type: 'text', placeholder: '例如：等当事人补材料' },
            ],
          });
          if (!v) return;
          await api(`/inbox/${i.id}/snooze`, { body: v });
          toast(`已延后至 ${v.until}`);
          load();
        },
      }, '稍后'),
      el('button', {
        class: 'btn danger', type: 'button',
        onclick: async () => {
          const v = await datePrompt({
            title: '不再建议',
            hint: '相同案件状态下，这个意图以后不会再次出现；案件发生实质变化时才可能重提并说明原因。',
            fields: [
              { key: 'reason', label: '原因（可选）', value: '现在不需要', type: 'text' },
            ],
          });
          if (!v) return;
          await api(`/inbox/${i.id}/decline`, { body: v });
          toast('已记住：不再建议');
          load();
        },
      }, '不再建议')
    )
  );
}

// ── 七日内开庭 / 待收款 / 期限缺口 / KPI ────────────────────────────
function hearRow(h, today) {
  const n = diffD(today, h.occurred_on);
  const rel = n <= 0 ? '今日' : n === 1 ? '明天' : `${n} 天后`;
  const chip = n <= 0 ? 'chip c-red' : n === 1 ? 'chip c-amber' : 'chip c-blue';
  return el('div', { class: 'hear' },
    el('div', { class: 'hear-top' },
      el('span', { class: 'hear-when' },
        rel,
        el('span', { class: 'wk' }, '·'),
        md(h.occurred_on),
        el('span', { class: 'wk' }, `（周${wd(h.occurred_on)}）`)
      ),
      el('span', { class: 'hear-rel' },
        el('span', { class: chip }, n <= 0 ? '今日开庭' : `剩 ${n} 天`)
      )
    ),
    el('div', { class: 'hear-name' }, caseLink(h.case_id, h.case_name)),
    h.instrument ? el('div', { class: 'hear-no' }, h.instrument) : null,
    h.note ? el('div', { class: 'hear-tags' }, el('span', { class: 'chip' }, h.note)) : null
  );
}

function payRow(f) {
  const n = f.days_left;
  const tone = n < 0 ? 'crit' : n <= 7 ? 'warn' : '';
  const label = n < 0 ? `逾期 ${-n} 日` : n === 0 ? '今日到期' : `剩 ${n} 日`;
  return el('div', { class: 'pay-row' },
    el('div', { class: 'p1' },
      el('div', { class: 't' }, caseLink(f.case_id, f.case_name), ' · ', f.label),
      el('div', { class: 'd' },
        m(md(f.due_on)), ' 到期 · ',
        el('span', { class: `days-left ${tone}`.trim() }, label)
      )
    ),
    el('span', { class: 'amt' }, f.amount != null ? yuan(f.amount) : '待定'),
    el('button', {
      class: 'btn small', type: 'button',
      onclick: async () => {
        const v = await datePrompt({
          title: `「${f.label}」确认收款`,
          hint: '后补时选实际到账日期',
          fields: [{ key: 'paid_on', label: '收款日期', value: todayStr(), required: true }],
        });
        if (!v) return;
        await api(`/fees/${f.id}`, { method: 'PATCH', body: { status: 'paid', paid_on: v.paid_on } });
        toast('已确认收款 ✓');
        load();
      },
    }, '确认收款')
  );
}

function gapRow(c) {
  return el('div', { class: 'gap-row' },
    el('i', { class: 'dot amber' }),
    el('div', { class: 'gap-body' },
      el('div', { class: 'g1' },
        caseLink(c.id, c.name), ' ',
        el('span', { class: 'case' }, `（${c.procedure}·${c.stage}）`)
      ),
      el('div', { class: 'g2' }, '在办，但无在追期限、七日内也无开庭')
    ),
    el('a', { class: 'gap-act', href: `/case.html?id=${c.id}` }, '补录期限 →')
  );
}

function kpiRow({ k, v, note = null, alert = false, href = null }) {
  return el(href ? 'a' : 'div', {
    class: 'kpi-row' + (alert ? ' alert' : ''),
    ...(href ? { href } : {}),
  },
    el('span', { class: 'k' }, k),
    el('span', { class: 'v' },
      el('b', {}, String(v)),
      note ? el('span', { class: 'vn' }, note) : null
    )
  );
}

// ── 通用容器填充（5 个板块共用；容器每次整体清空重建）────────────────
function fill(id, rows, emptyText) {
  const box = document.getElementById(id);
  box.replaceChildren();
  if (!rows.length) box.append(el('div', { class: 'section-empty' }, emptyText));
  else box.append(...rows);
}

// ── 键盘（只提示真实实现了的键；见 index.html 的 .p-foot）─────────────
let rwLinks = [];
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if (e.key === '/' && !typing) {
    const q = document.querySelector('.quickbar input[type=text]');
    if (q) { e.preventDefault(); q.focus(); }
    return;
  }
  if (typing) return;
  if (/^[1-9]$/.test(e.key)) {
    const href = rwLinks[Number(e.key) - 1];
    if (href) { e.preventDefault(); location.href = href; }
  }
});

async function load() {
  const d = await api('/digest');
  const today = d.date;

  document.getElementById('title').replaceChildren(
    '今日',
    el('span', { class: 'mid' }, '·'),
    el('span', { class: 'date' }, today),
    el('span', { class: 'wk' }, `（周${wd(today)}）`)
  );
  document.getElementById('subtitle').textContent = '期限跑道按剩余天数收窄——越短越急';

  // 今日概览（右栏紧凑 KPI 清单）
  const overdue = d.red.filter((x) => x.days_left < 0).length;
  const hearToday = d.hearings.filter((h) => h.is_today).length;
  const hearTmr = d.hearings.filter((h) => h.occurred_on === shift(today, 1)).length;
  document.getElementById('tiles').replaceChildren(
    kpiRow({
      k: '临期/逾期死线', v: d.red.length, alert: d.red.length > 0,
      note: overdue ? ['含 ', m(overdue), ' 逾期'] : null,
    }),
    kpiRow({
      k: '今日开庭', v: hearToday, alert: hearToday > 0,
      note: hearTmr ? ['明日 ', m(hearTmr)] : null,
    }),
    kpiRow({ k: '在办案件', v: d.counts.active_cases, href: '/cases.html' }),
    kpiRow({ k: '未结待办', v: d.counts.open_tasks }),
    kpiRow({ k: '待收', v: yuan(d.counts.unpaid_fees), href: '/fees.html' })
  );

  // 收件箱：为空时整卡隐藏（原生 hidden 属性）
  const inboxCard = document.getElementById('sec-inbox-card');
  if (d.counts.inbox_pending > 0) {
    inboxCard.hidden = false;
    const items = await api('/inbox?status=pending');
    document.getElementById('inbox-meta').replaceChildren(
      'LLM 提取，确认后才入正式表', sep(), m(`${items.length} 条`)
    );
    fill('inbox-list', items.map(inboxRow), '');
  } else {
    inboxCard.hidden = true;
  }

  // 期限跑道：逾期 + 30 日内全部 pending 死线，一图看尽
  const allDl = [...d.red, ...d.week, ...d.watch];
  document.getElementById('runway-count').textContent = allDl.length ? `${allDl.length} 条在追` : '';
  document.getElementById('runway-meta').replaceChildren(
    '按剩余天数升序', sep(), m(`${allDl.length} 项`),
    ...(overdue ? [sep(), el('span', { class: 'm hot' }, `${overdue} 逾期`)] : [])
  );
  rwLinks = allDl.map((x) => `/case.html?id=${x.case_id}`);
  document.getElementById('sec-lead').replaceChildren(
    allDl.length ? leadRow(allDl[0]) : el('div', { class: 'section-empty focus-empty' }, '30 日内无在追死线')
  );
  document.getElementById('sec-runway').replaceChildren(
    allDl.length > 1 ? runwayPanel(allDl.slice(1)) : el('div', { class: 'section-empty' }, '没有其他在追期限')
  );

  // 未来 14 日
  const marks = {};
  for (const x of allDl) {
    const band = x.days_left <= 3 ? 'critical' : x.days_left <= 7 ? 'high' : 'normal';
    (marks[x.due_on] ||= { deadlines: [] }).deadlines.push(band);
  }
  for (const h of d.hearings) (marks[h.occurred_on] ||= { deadlines: [] }).hearings = (marks[h.occurred_on].hearings || 0) + 1;
  for (const t of d.today_tasks) if (t.due_on) (marks[t.due_on] ||= { deadlines: [] }).tasks = (marks[t.due_on].tasks || 0) + 1;
  document.getElementById('strip-range').textContent = `${md(today)} – ${md(shift(today, 13))}`;
  document.getElementById('sec-strip').replaceChildren(strip14(today, marks));

  // 七日内开庭
  document.getElementById('hearings-meta').replaceChildren(
    '今日 ', m(hearToday), sep(), '七日内 ', m(d.hearings.length)
  );
  fill('sec-hearings', d.hearings.map((h) => hearRow(h, today)), '七日内无开庭');

  // 今日待办
  document.getElementById('tasks-meta').replaceChildren(
    m(`${d.today_tasks.length} 项`), sep(), '未结共 ', m(d.counts.open_tasks)
  );
  fill('sec-tasks', d.today_tasks.map((t) => taskRow(t, today)), '今日无到期待办');

  // 本周待办（今日 < effective ≤ today+7，与今日互斥）
  document.getElementById('weektasks-meta').replaceChildren(
    m(`${d.week_tasks.length} 项`), sep(), '未结共 ', m(d.counts.open_tasks)
  );
  fill('sec-weektasks', d.week_tasks.map((t) => taskRow(t, today)), '本周无新增待办');

  // 全部待办（兜底，含无日期「未排期」项）
  const allOverdue = d.all_tasks.filter((t) => t.due_on && t.due_on < today).length;
  document.getElementById('alltasks-meta').textContent = `全部 ${d.all_tasks.length} 条 · 逾期 ${allOverdue}`;
  fill('sec-alltasks', d.all_tasks.map((t) => taskRow(t, today)), '没有未结待办');

  // 待收款
  const feeSum = d.fees_due.reduce((s, f) => s + (f.amount || 0), 0);
  document.getElementById('fees-meta').replaceChildren('合计 ', m(yuan(feeSum)));
  fill('sec-fees', d.fees_due.map(payRow), '无临期待收款');

  // 期限缺口（事实条）：0 处时显示健康文案、隐藏「去补」；有缺口时给案名摘要
  const gapCount = d.no_deadline_cases.length;
  const gapFact = document.getElementById('gap-meta');
  const gapBtn = document.getElementById('today-gap-toggle');
  if (gapFact) {
    gapFact.textContent = gapCount
      ? `缺口 ${gapCount} 处 · ${d.no_deadline_cases.slice(0, 2).map((c) => c.case_name || '未命名').join(' · ')}${gapCount > 2 ? ' 等' : ''}`
      : '每个在办案件都有在追期限 ✓';
  }
  if (gapBtn) gapBtn.hidden = !gapCount;
  fill('sec-gap', d.no_deadline_cases.map(gapRow), '每个在办案件都有在追期限 ✓');
}

document.addEventListener('anjian:changed', load);
await load();
