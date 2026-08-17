// 手绘 SVG/HTML 图表组件（dataviz 规程：状态色仅表状态且必带文字标签；
// 单序列不放图例；细 mark + 2px 间隙；文字用文本色不穿序列色；hover 有反馈）。
import { el } from './api.js';

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

// ---- 期限跑道：每条 pending 期限一行，条长 ∝ 剩余天数（0–30 封顶），
// 逾期条反向红色。状态用色 + 文字天数双编码。 ----
export function runway(items, { maxDays = 30, linkCase = true, onDone = null } = {}) {
  const wrap = el('div', { class: 'runway' + (onDone ? ' runway-act' : '') });
  if (!items.length) return wrap;
  for (const d of items) {
    const days = d.days_left;
    const band = days < 0 ? 'over' : days <= 3 ? 'crit' : days <= 7 ? 'warn' : 'ok';
    const pct = days < 0 ? 100 : clamp((days / maxDays) * 100, 4, 100);
    const label = days < 0 ? `逾期 ${-days} 日` : days === 0 ? '今日' : `${days} 日`;
    const row = el('a', {
      class: `rw-row rw-${band}`,
      href: `/case.html?id=${d.case_id}`,
      title: `${d.case_name}｜${d.name}｜${d.due_on}${d.basis ? '｜' + d.basis : ''}`,
    },
      el('span', { class: 'rw-label' },
        el('b', {}, d.name),
        linkCase ? el('span', { class: 'rw-case' }, d.case_name) : null
      ),
      el('span', { class: 'rw-track' },
        el('span', { class: 'rw-fill', style: `width:${pct}%` }),
        d.severity === 'critical' ? el('span', { class: 'rw-flag', 'aria-label': '致命期限' }, '!') : null
      ),
      el('span', { class: `rw-days rw-days-${band}` }, label),
      el('span', { class: 'rw-due' }, d.due_on.slice(5)),
      onDone ? el('button', {
        class: 'btn small rw-done', 'aria-label': `完成期限：${d.name}`,
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); onDone(d); },
      }, '完成') : null
    );
    wrap.append(row);
  }
  // 状态图例（状态≠序列，带文字标签）
  wrap.append(el('div', { class: 'rw-legend' },
    el('span', { class: 'lg lg-crit' }, '≤3 日/逾期'),
    el('span', { class: 'lg lg-warn' }, '4–7 日'),
    el('span', { class: 'lg lg-ok' }, '8–30 日')
  ));
  return wrap;
}

// ---- 未来 14 日横带：每日一格，格内按类型放点（deadline 按紧迫度状态色、
// 开庭=类目蓝、任务=中性），今天描边。 ----
export function strip14(today, marks) {
  // marks: {date: {deadlines:[sev…], hearings:n, tasks:n}}
  const wrap = el('div', { class: 'strip' });
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  for (let i = 0; i < 14; i++) {
    const dt = new Date(today + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + i);
    const ds = dt.toISOString().slice(0, 10);
    const m = marks[ds] || {};
    const dots = [];
    for (const sev of m.deadlines || []) {
      dots.push(el('span', { class: `dot dot-${sev}`, title: '期限' }));
    }
    if (m.hearings) dots.push(el('span', { class: 'dot dot-event', title: '开庭' }));
    if (m.tasks) dots.push(el('span', { class: 'dot dot-task', title: '待办到期' }));
    wrap.append(el('div', { class: 'strip-day' + (i === 0 ? ' strip-today' : '') + (dt.getUTCDay() % 6 === 0 ? ' strip-weekend' : '') },
      el('span', { class: 'strip-dow' }, WEEK[dt.getUTCDay()]),
      el('span', { class: 'strip-num' }, String(dt.getUTCDate())),
      el('span', { class: 'strip-dots' }, dots.slice(0, 4))
    ));
  }
  const legend = el('div', { class: 'rw-legend' },
    el('span', { class: 'lg lg-crit' }, '期限(≤3日)'),
    el('span', { class: 'lg lg-warn' }, '期限(4–7日)'),
    el('span', { class: 'lg lg-ok' }, '期限(>7日)'),
    el('span', { class: 'lg lg-event' }, '开庭'),
    el('span', { class: 'lg lg-task' }, '待办')
  );
  return el('div', {}, wrap, legend);
}

// ---- 阶段步进器 ----
export function stepper(stages, current, onPick = null) {
  const wrap = el('div', { class: 'stepper' + (onPick ? ' stepper-live' : '') });
  const idx = stages.indexOf(current);
  stages.forEach((s, i) => {
    const state = i < idx ? 'done' : i === idx ? 'cur' : 'todo';
    const node = el(onPick ? 'button' : 'span', {
      class: `step step-${state}`,
      ...(onPick ? { type: 'button', onclick: () => onPick(s), title: `切换到「${s}」` } : {}),
    },
      el('span', { class: 'step-dot' }, i < idx ? '✓' : ''),
      el('span', { class: 'step-name' }, s)
    );
    wrap.append(node);
    if (i < stages.length - 1) wrap.append(el('span', { class: `step-link ${i < idx ? 'step-link-done' : ''}` }));
  });
  return wrap;
}

// ---- 迷你步进（案件卡）：只画点 ----
export function miniStepper(stages, current) {
  const idx = stages.indexOf(current);
  const wrap = el('span', { class: 'ministep', title: `${current}（${idx + 1}/${stages.length}）` });
  stages.forEach((s, i) => {
    wrap.append(el('span', { class: 'mini-dot ' + (i < idx ? 'md-done' : i === idx ? 'md-cur' : 'md-todo') }));
  });
  return wrap;
}

// ---- 费用堆叠条：已收/未收（+待定注记），2px 间隙，金额用文本色 ----
export function feeBar({ paid, unpaid, tbd = 0 }) {
  const total = paid + unpaid;
  const wrap = el('div', { class: 'feebar-wrap' });
  if (total <= 0 && !tbd) return wrap;
  const bar = el('div', { class: 'feebar', role: 'img', 'aria-label': `已收 ${paid} 元，未收 ${unpaid} 元` });
  if (total > 0) {
    if (paid > 0) bar.append(el('span', { class: 'fee-paid', style: `flex:${paid}` }));
    if (unpaid > 0) bar.append(el('span', { class: 'fee-unpaid', style: `flex:${unpaid}` }));
  }
  wrap.append(bar, el('div', { class: 'fee-legend' },
    el('span', { class: 'lg lg-good' }, `已收 ¥${paid.toLocaleString()}`),
    el('span', { class: 'lg lg-warn' }, `未收 ¥${unpaid.toLocaleString()}`),
    tbd ? el('span', { class: 'lg lg-task' }, `另 ${tbd} 项待定`) : null
  ));
  return wrap;
}

// ---- KPI 瓷片 ----
export function statTile({ label, value, tone = '', href = null, iconEl = null }) {
  const t = el(href ? 'a' : 'div', { class: `tile tile-${tone}`, ...(href ? { href } : {}) },
    iconEl,
    el('span', { class: 'tile-v' }, String(value)),
    el('span', { class: 'tile-l' }, label)
  );
  return t;
}
