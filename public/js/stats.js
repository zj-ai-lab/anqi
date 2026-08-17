// 数据统计 —— 全页读 GET /api/stats（src/routes/views.js），零硬编码演示数据。
//
// 画法沿用 v2 的手写图表，只是把写死的数字/坐标换成按 API 数据现算：
//   环形 = stroke-dasharray 切弧 · 柱状 = height% · 折线 = polyline + 零长圆点 · 仪表 = 半圆弧
// SVG 子节点必须 createElementNS（api.js 的 el() 走 createElement，画不了 svg）→ 本文件的 sv()。
//
// 口径（与后端逐字对齐，页面文案不许另说一套）：
//   · deadlines 只统计**本年度已到期**的期限；compliance = 按期完成 ÷ 已到期，
//     due_total=0 时为 null → 仪表中心显示「—」，绝不显示假的 0%/100%。
//   · missed 含 status='missed' 与「pending 但 due_on 已过」两种。
//     四态之和可能小于 due_total（今日到期、当天还没结果的那种）—— 差额单列一行，
//     弧上留给底轨，不硬塞进任何一态。
//   · 费用 amount=null = 金额待定，不计入任何求和，只用 tbd_count 记数。
//   · 分成后净收（年）= 本年已收 − 应付分成 + 应收分成；分成按 due_month 归年，含 pending/settled、不含 waived。
//   · trend.paid = 近 6 月按 paid_on 归月的**已收**金额（元）。
//
// 色板（三皮肤共用，禁硬编码色值 —— 硬编码在 jade 暗皮肤下必瞎）：
//   · 多序列（案件状态 / 案由）→ --chart-1..6；超过 6 类自动并成「其他」，永不两段同色。
//   · 期限三态 → --green（按期）/ --amber（逾期后补做）/ --red（已错过）/ --gray-dot（放弃）。
//   · 账龄四档 → .progress-fill 的 ok / warn / warn-deep / crit。
//
// 空数据一律出空态文案，绝不画一个全 0 的假图（库里费用全 0 是常态，不是意外）。
//
// DOM 契约（改 stats.html 必须同步这份清单）：
//   · #stats-period                              副标题，textContent 覆盖
//   · #p-deadlines #dl-meta #dl-chart #dl-foot   期限履约（.kpi-row insertBefore(#dl-foot)）
//   · #cases-meta #cases-chart                   案件总览（环形）
//   · #cause-meta #cause-chart                   案由分布（环形）
//   · #stage-meta #stage-chart #stage-note       在办阶段（柱状）
//   · #p-quick                                   年度速览（.kpi-row append）
//   · #trend-range #trend-chart                  收结案趋势（折线）
//   · #fee-unit #fee-range #fee-net-tiles #fee-chart #fee-foot  已收律师费（净收 tile + 柱状）
//   · #p-aging #ar-meta #ar-foot                 应收账龄（.prog-row insertBefore(#ar-foot)）
//   ⚠ .kpi-row / .prog-row 必须直接挂 .panel（分隔线靠 :first-child 与 .p-head + .prog-row
//     两条位置选择器归零），所以一律 insertBefore 进面板，不套容器 div。
import { api, el } from './api.js';
import { mountNav } from './nav.js';
import { statTile } from './charts.js';

await mountNav();

const $ = (id) => document.getElementById(id);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const yuan = (n) => '¥' + Number(n || 0).toLocaleString('zh-CN');
const moLabel = (iso) => `${Number(iso.slice(5))}月`;          // '2026-07' → '7月'
const m = (v) => el('span', { class: 'm' }, String(v));         // .p-meta / .vn 里的数字（走 --f-num）
const sep = () => el('span', {}, '·');
const emptyBox = (text) => el('div', { class: 'section-empty' }, text);

// SVG 节点（createElementNS；属性值里的颜色一律 var(--x)，坐标才是数字）
const SVG_NS = 'http://www.w3.org/2000/svg';
function sv(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, v);
  for (const c of kids.flat()) if (c) n.append(c);
  return n;
}

// .kpi-row：<span class=k>标签</span><span class=v><b>值</b><span class=vn>注</span></span>
const kpiRow = (label, value, note = [], alert = false) =>
  el('div', { class: 'kpi-row' + (alert ? ' alert' : '') },
    el('span', { class: 'k' }, label),
    el('span', { class: 'v' },
      el('b', {}, String(value)),
      note.length ? el('span', { class: 'vn' }, note) : null
    )
  );

// 图例：序列色标用 .c1–.c6，状态色标用 .s-ok/.s-warn/.s-crit/.s-mute（色值与图上同 token）
const legend = (items) => el('div', { class: 'chart-legend' },
  items.map((it) => el('span', { class: `lg ${it.cls}`, title: it.title }, it.text))
);

// ── 环形图（r=60 → 周长 377；.donut svg 已整体 rotate(-90deg)，起点 12 点方向） ──
// 段长 = 占比 × 周长，dashoffset = −已累计长度；gap 段给满周长，保证一段只画一次。
const R = 60;
const C = 2 * Math.PI * R;
function donut(segs, centerV, centerL) {
  const total = sum(segs.map((x) => x.n));
  const svg = sv('svg', { viewBox: '0 0 160 160', 'aria-hidden': 'true' },
    sv('circle', { cx: 80, cy: 80, r: R, fill: 'none', stroke: 'var(--track)', 'stroke-width': 24 })
  );
  let acc = 0;
  for (const sg of segs) {
    const len = (sg.n / total) * C;
    svg.append(sv('circle', {
      cx: 80, cy: 80, r: R, fill: 'none', stroke: sg.color, 'stroke-width': 24,
      'stroke-dasharray': `${len.toFixed(1)} ${C.toFixed(1)}`,
      'stroke-dashoffset': (-acc).toFixed(1),
    }));
    acc += len;
  }
  return el('div', { class: 'donut' }, svg,
    el('div', { class: 'donut-center' },
      el('span', { class: 'v' }, String(centerV)),
      el('span', { class: 'l' }, centerL)
    )
  );
}

// ── 半圆仪表（圆心 80,90 半径 70；弧扫过 180° × 占比） ──
// 堆叠四态：单段时用圆头（＝旧版单值仪表的样子），多段时改平头，否则相邻段的圆帽会互相啃。
const GX = 80, GY = 90, GR = 70;
const gaugePt = (f) => {                       // f ∈ [0,1] → 弧上一点（180° → 0°）
  const a = Math.PI * (1 - f);
  return [GX + GR * Math.cos(a), GY - GR * Math.sin(a)];
};
const gaugeArc = (from, to) => {
  const [x1, y1] = gaugePt(from);
  const [x2, y2] = gaugePt(to);
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${GR} ${GR} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
};
function gauge(segs, total, centerV, centerL) {
  const svg = sv('svg', { viewBox: '0 0 160 100', 'aria-hidden': 'true' },
    sv('path', { d: gaugeArc(0, 1), fill: 'none', stroke: 'var(--track)', 'stroke-width': 14, 'stroke-linecap': 'round' })
  );
  const cap = segs.length === 1 ? 'round' : 'butt';
  let acc = 0;
  for (const sg of segs) {
    svg.append(sv('path', {
      d: gaugeArc(acc / total, (acc + sg.n) / total),
      fill: 'none', stroke: sg.color, 'stroke-width': 14, 'stroke-linecap': cap,
    }));
    acc += sg.n;
  }
  return el('div', { class: 'gauge' }, svg,
    el('div', { class: 'gauge-center' },
      el('span', { class: 'v' }, centerV),
      el('span', { class: 'l' }, centerL)
    )
  );
}

// ── 柱状图（单序列 → 单色：位置已能识别类别，不需要按类目上色） ──
// 柱高 = 72% × 值/最大值，余下 28% 留给 .bar-val + .bar-label 两行。
function barChart(items) {
  const max = Math.max(...items.map((x) => x.n));
  return el('div', { class: 'bar-chart' },
    items.map((x) => el('div', { class: 'bar-col' },
      el('span', { class: 'bar-val' }, x.text),
      el('div', {
        class: 'bar c1',
        style: `height:${max > 0 ? ((x.n / max) * 72).toFixed(1) : 0}%`,   // 动态高度＝唯一允许的内联 style
        title: `${x.label}：${x.text}`,
      }),
      el('span', { class: 'bar-label', title: x.label }, x.label)
    ))
  );
}

// ── 折线图（viewBox 880×180，preserveAspectRatio=none 横向拉伸填满） ──
// · y：0 → 156，最大值 → 24（132px 可用高）
// · x：n 等分列心 = (i+0.5)·880/n，与 .chart-axis 的等分 grid 列心逐点对齐
// · 所有描边 vector-effect=non-scaling-stroke；数据点用「零长 + 圆头线段」——拉伸下不变椭圆
const VW = 880, Y0 = 156, Y1 = 24, YH = Y0 - Y1;
function lineChart(months, series, aria) {
  const max = Math.max(1, ...series.flatMap((s) => s.data));
  const cx = (i) => ((i + 0.5) * VW) / months.length;
  const cy = (v) => Y0 - (v / max) * YH;
  const svg = sv('svg', { viewBox: `0 0 ${VW} 180`, preserveAspectRatio: 'none', role: 'img', 'aria-label': aria });

  // 网格线 = 0…max 的等分刻度（≤4 格）。无 y 轴标签，纯节奏线，但刻度真实对齐整数值。
  const ticks = Math.min(max, 4);
  for (let i = 0; i <= ticks; i++) {
    const y = (Y0 - (i / ticks) * YH).toFixed(1);
    svg.append(sv('line', { class: 'grid-line', x1: 0, y1: y, x2: VW, y2: y, 'vector-effect': 'non-scaling-stroke' }));
  }
  // 次要序列（虚线）先画 → 主序列后画压在上层：两线同值时点必然重合，z 序保证主序列始终可见。
  for (const s of series) {
    svg.append(sv('polyline', {
      points: s.data.map((v, i) => `${cx(i).toFixed(1)},${cy(v).toFixed(1)}`).join(' '),
      fill: 'none', stroke: s.color, 'stroke-width': 2.5,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'stroke-dasharray': s.dash ? '5 4' : null,
      'vector-effect': 'non-scaling-stroke',
    }));
    s.data.forEach((v, i) => svg.append(sv('line', {
      x1: cx(i).toFixed(1), y1: cy(v).toFixed(1), x2: cx(i).toFixed(1), y2: cy(v).toFixed(1),
      stroke: s.color, 'stroke-width': 7, 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke',
    })));
  }
  return el('div', { class: 'line-chart' }, svg);
}
const monthAxis = (months) => el('div', { class: 'chart-axis' },
  months.map((mo) => el('span', { class: 'axis-label' }, moLabel(mo)))
);


// ═══════════════ 板块 1 · 期限履约（头条 + 仪表 + KPI 清单） ═══════════════
function renderDeadlines(dl) {
  const { due_total: due, on_time: onTime, late_done: late, missed, waived, compliance } = dl;
  // 今日到期、当天还没有结果的那种：进了分母但四态都不占 —— 单列，别硬塞进「已错过」
  const today = Math.max(0, due - onTime - late - missed - waived);

  $('dl-meta').append('本年度已到期', m(`${due} 项`));
  if (missed > 0) $('dl-meta').append(sep(), el('span', { class: 'hot' }, '已错过 ', m(missed)));

  // 头条：全页最大的数字 = 错过次数（missed=0 时 .hd-calm 脱红——红＝告警，平静态不满屏红）
  const deck = due === 0
    ? [el('span', {}, '本年度尚无已到期期限——履约率待首个期限到期后可算')]
    : [el('span', {}, `${due} 项已到期期限中，${missed} 项到期未完成`)];
  if (late > 0) deck.push(el('span', { class: 'sep' }, '·'), el('span', {}, `另有 ${late} 项逾期后补做`));
  if (today > 0) deck.push(el('span', { class: 'sep' }, '·'), el('span', {}, `${today} 项今日到期、待完成`));

  const head = el('div', { class: 'chart-side' + (missed > 0 ? '' : ' hd-calm') },
    el('div', { class: 'hd-kick' }, '本年度 · 已错过期限'),
    el('div', { class: 'hd-num' }, el('span', { class: 'n' }, String(missed)), el('span', { class: 'w' }, '件')),
    el('div', { class: 'hd-rule', 'aria-hidden': 'true' }),
    el('div', { class: 'hd-meta' }, deck)
  );

  // 仪表：四态堆叠弧（合计 ≤ due，差额留给底轨）；中心 = 按期完成率，null 时「—」
  const segs = [
    { n: onTime, color: 'var(--green)', cls: 's-ok', text: `按期完成 ${onTime}` },
    { n: late, color: 'var(--amber)', cls: 's-warn', text: `逾期后补做 ${late}` },
    { n: missed, color: 'var(--red)', cls: 's-crit', text: `已错过 ${missed}` },
    { n: waived, color: 'var(--gray-dot)', cls: 's-mute', text: `已放弃 ${waived}` },
  ].filter((x) => x.n > 0);

  const chart = $('dl-chart');
  chart.append(el('div', { class: 'gauge-wrap' },
    head,
    gauge(segs, due || 1, compliance === null ? '—' : `${compliance}%`, '按期完成率')
  ));
  // ⚠ 原生 append() 会把 null 转成字符串 "null" 塞进 DOM（不像 el() 会跳过）——
  //   零已到期期限时 segs 为空，这里必须真的不调用，不能 append(cond ? x : null)。
  if (segs.length) chart.append(legend(segs));

  // KPI 清单（直接挂 .panel，插在 p-foot 之前）
  const panel = $('p-deadlines');
  const foot = $('dl-foot');
  const rows = [
    kpiRow('按期完成', onTime, ['件']),
    kpiRow('逾期后补做', late, ['件']),
    kpiRow('已错过 · 未完成', missed, ['件'], missed > 0),
  ];
  if (today > 0) rows.push(kpiRow('今日到期 · 待完成', today, ['件']));
  if (waived > 0) rows.push(kpiRow('已放弃', waived, ['件']));
  rows.push(kpiRow('已到期期限合计', due, ['件']));
  for (const r of rows) panel.insertBefore(r, foot);
}

// ═══════════════ 板块 2 · 案件总览（环形：状态） ═══════════════
function renderCases(c) {
  $('cases-meta').append('按状态', sep(), m(`${c.total} 件`));
  const box = $('cases-chart');
  if (!c.total) {
    box.append(emptyBox('还没有案件——从「案件」页立项后这里才有分布'));
    return;
  }
  // 状态是固定三类，色位钉死（在办 c1 / 搁置 c4 / 已结 c5），不随数据顺序漂移
  const segs = [
    { n: c.active, i: 1, text: `在办 ${c.active}` },
    { n: c.shelved, i: 4, text: `搁置 ${c.shelved}` },
    { n: c.closed, i: 5, text: `已结 ${c.closed}` },
  ].filter((x) => x.n > 0);
  box.append(el('div', { class: 'donut-wrap' },
    donut(segs.map((x) => ({ n: x.n, color: `var(--chart-${x.i})` })), c.total, '案件总数'),
    el('div', { class: 'chart-side' }, legend(segs.map((x) => ({ cls: `c${x.i}`, text: x.text }))))
  ));
}

// ═══════════════ 板块 3 · 案由分布（环形：全部案件按案由） ═══════════════
// 色板只有 6 位 → 超过 6 类就把尾巴并成「其他」（并到第 6 位），
// 绝不循环复用色位：两段同色的环形图等于没有图例。
const MAX_SLICES = 6;
function renderCause(list, total) {
  $('cause-meta').append(`${list.length} 类`, sep(), m(`${total} 件`));
  const box = $('cause-chart');
  if (!list.length || !total) {
    box.append(emptyBox('还没有案件——案由分布待首个案件立项后生成'));
    return;
  }
  let segs = list.map((x, i) => ({ n: x.count, label: x.label, i: i + 1 }));
  if (list.length > MAX_SLICES) {
    const rest = list.slice(MAX_SLICES - 1);
    segs = list.slice(0, MAX_SLICES - 1).map((x, i) => ({ n: x.count, label: x.label, i: i + 1 }));
    segs.push({
      n: sum(rest.map((x) => x.count)),
      label: '其他',                                   // 图例恒「名 + 件数」，别写成「其他 N 类 N」
      i: MAX_SLICES,
      title: `并入 ${rest.length} 类：` + rest.map((x) => `${x.label} ${x.count}`).join(' · '),
    });
  }
  box.append(el('div', { class: 'donut-wrap' },
    donut(segs.map((x) => ({ n: x.n, color: `var(--chart-${x.i})` })), list.length, '案由类型'),
    el('div', { class: 'chart-side' },
      legend(segs.map((x) => ({ cls: `c${x.i}`, text: `${x.label} ${x.n}`, title: x.title })))
    )
  ));
}

// ═══════════════ 板块 4 · 在办案件 · 阶段分布（柱状） ═══════════════
function renderStage(list, c) {
  $('stage-meta').append(`${list.length} 个阶段`, sep(), m(`在办 ${c.active} 件`));
  const box = $('stage-chart');
  if (!list.length) {
    box.append(emptyBox('无在办案件——阶段分布只数 status=active 的案件'));
  } else {
    box.append(barChart(list.map((x) => ({ label: x.label, n: x.count, text: String(x.count) }))));
  }
  const rest = c.shelved + c.closed;
  $('stage-note').textContent = rest
    ? `搁置 ${c.shelved} · 已结 ${c.closed} 件不计入`
    : '仅统计在办案件';
}

// ═══════════════ 板块 5 · 年度速览 ═══════════════
function renderQuick(d) {
  const { cases: c, deadlines: dl, fees: f } = d;
  const overdue = f.aging.overdue_30 + f.aging.overdue_90 + f.aging.overdue_90p;
  const rate = dl.compliance === null ? '—' : `${dl.compliance}%`;
  const arNote = overdue > 0 ? ['逾期 ', m(yuan(overdue))]
    : f.tbd_count > 0 ? [`另 ${f.tbd_count} 项待定`] : [];
  $('p-quick').append(
    kpiRow('案件总数', c.total, ['在办 ', m(c.active)]),
    kpiRow(`${d.year} 年结案`, c.closed_this_year, ['件']),
    kpiRow('已错过期限', dl.missed, ['按期率 ', m(rate)], dl.missed > 0),
    kpiRow(`${d.year} 年已收费`, yuan(f.paid_year)),
    kpiRow('应收未收', yuan(f.unpaid_total), arNote)
  );
}

// ═══════════════ 板块 6 · 收结案趋势（折线） ═══════════════
function renderTrend(t) {
  const { months } = t;
  $('trend-range').textContent = `${months[0]} – ${months[months.length - 1]}`;
  const box = $('trend-chart');
  const nOpen = sum(t.opened);
  const nClosed = sum(t.closed);
  if (!nOpen && !nClosed) {
    box.append(emptyBox('近 6 个月无新收 / 结案记录'));
    return;
  }
  box.append(
    lineChart(months, [
      { data: t.closed, color: 'var(--chart-4)', dash: true },   // 次要序列先画（见 lineChart 注释）
      { data: t.opened, color: 'var(--chart-1)' },
    ], `近 6 个月收结案趋势：新收合计 ${nOpen} 件，结案合计 ${nClosed} 件`),
    monthAxis(months),
    legend([
      { cls: 'c1', text: `新收 ${nOpen} 件` },
      { cls: 'c4', text: `结案 ${nClosed} 件（虚线）` },
    ])
  );
}

// ═══════════════ 板块 7 · 已收律师费（柱状） ═══════════════
// 单位随数据走：最大月 ≥ 1 万 → 柱值记「万元」，否则记「元」（栏头声明单位，别让读者猜）。
function renderFee(t, f) {
  const { months } = t;
  $('fee-range').textContent = `${months[0]} – ${months[months.length - 1]}`;

  const netTile = statTile({ label: '分成后净收（年）', value: yuan(f.net_year) });
  netTile.append(el('span', { class: 'tile-l' }, '本年已收 − 应付分成 + 应收分成（含未结）'));
  if (!f.net_year) netTile.classList.add('is-zero');
  $('fee-net-tiles').replaceChildren(netTile);

  const box = $('fee-chart');
  const total = sum(t.paid);
  if (!total) {
    $('fee-unit').textContent = '按实收日期归月';
    box.append(emptyBox('近 6 个月还没有已收款项——款项在案件页登记'));
    $('fee-foot').textContent = f.tbd_count > 0
      ? `另有 ${f.tbd_count} 项金额待定，不计入求和`
      : '口径：按 paid_on（实收日期）归月';
    return;
  }
  const useWan = Math.max(...t.paid) >= 10000;
  $('fee-unit').textContent = useWan ? '万元' : '元';
  box.append(barChart(months.map((mo, i) => ({
    label: moLabel(mo),
    n: t.paid[i],
    text: useWan ? (t.paid[i] / 10000).toFixed(1) : t.paid[i].toLocaleString('zh-CN'),
  }))));
  $('fee-foot').textContent = `近 6 个月合计 ${yuan(total)}`
    + (f.tbd_count > 0 ? ` · 另 ${f.tbd_count} 项金额待定` : '');
}

// ═══════════════ 板块 8 · 应收账龄（4 档进度条） ═══════════════
function renderAging(f) {
  const a = f.aging;
  const total = f.unpaid_total;
  const overdue = a.overdue_30 + a.overdue_90 + a.overdue_90p;
  const panel = $('p-aging');
  const foot = $('ar-foot');
  $('ar-meta').append('合计', m(yuan(total)));

  if (!total) {
    panel.insertBefore(emptyBox(
      f.tbd_count > 0
        ? `还没有应收款项（另有 ${f.tbd_count} 项金额待定，不计入求和）`
        : '还没有应收款项——款项在案件页登记，未收的会按账龄排到这里'
    ), foot);
    const t1 = $('ar-foot-text');
    if (t1) t1.textContent = '口径：已登记未收款（金额待定的不计入）';
    return;
  }
  // 严重度梯度：未到期 green → 30 日内 amber → 31–90 amber 深 → 90+ red（档位另有文字标签，色仅冗余编码）
  const bands = [
    { t: '未到期', v: a.not_due, cls: 'ok' },
    { t: '逾期 30 日内', v: a.overdue_30, cls: 'warn' },
    { t: '逾期 31–90 日', v: a.overdue_90, cls: 'warn-deep' },
    { t: '逾期 90 日以上', v: a.overdue_90p, cls: 'crit' },
  ];
  for (const b of bands) {
    panel.insertBefore(el('div', { class: 'prog-row' },
      el('span', { class: 't' }, b.t),
      el('span', { class: 'num' }, yuan(b.v)),
      el('div', { class: 'progress-track' },
        // 0 元的档不画条（.progress-fill 有 min-width:8px，画了就是个假条）
        b.v > 0 ? el('div', { class: `progress-fill ${b.cls}`, style: `width:${((b.v / total) * 100).toFixed(1)}%` }) : null
      )
    ), foot);
  }
  // 逾期合计写在 p-head 的 meta；口径写进事实条的 #ar-foot-text
  const t2 = $('ar-foot-text');
  if (t2) t2.textContent = '逾期合计 ' + yuan(overdue) + ' · 口径：已登记未收款'
    + (f.tbd_count > 0 ? `，另 ${f.tbd_count} 项金额待定` : '');
}


// ═══════════════ 取数 → 渲染 ═══════════════
let d = null;
try {
  d = await api('/stats');
} catch {
  /* api() 已经 toast 过；这里只出降级文案，不再把异常抛成 unhandled rejection */
}

if (!d) {
  $('stats-period').textContent = '统计数据加载失败——请刷新重试';
} else {
  // 副标题：年度 + 截至日，一律用后端的 as_of（Asia/Shanghai），别用浏览器本地时钟
  $('stats-period').textContent = `${d.year} 年度 · 截至 ${d.as_of.slice(5)}`;
  renderDeadlines(d.deadlines);
  renderCases(d.cases);
  renderCause(d.cases.by_cause, d.cases.total);
  renderStage(d.cases.by_stage, d.cases);
  renderQuick(d);
  renderTrend(d.trend);
  renderFee(d.trend, d.fees);
  renderAging(d.fees);
}
