// 律师费台账：总账等式 · 经营信号 · 按案收款规模 · 案件资金明细 · 人类可读分成约定与实际台账。
// DOM 契约见 fees.html：#subtitle #ledger-overview #fee-signals #detail
//   #share-meta #share-rows #share-foot #share-payable #share-receivable #share-repairs-link
// v2 骨架：标题零图标（CRITIQUE 修复项：icon slop）；颜色一律走 class，不写内联色。
import { api, el, toast, todayStr } from './api.js';
import { mountNav } from './nav.js';
import { datePrompt } from './dateedit.js';
import { feeSettlementActions, openFeeSettlement } from './fee-settlement.js';
import { renderFeeVouchers } from './fee-vouchers.js';
import { bindFold, setFoldOpen } from './fold.js';

await mountNav();

// 分成约定事实条：「改/收起」就地展开同条内的详情区（.factstrip-more），不走 fold.js。
const agreementsMore = document.getElementById('share-agreement-rows');
const agreementsToggle = document.getElementById('fees-agreements-toggle');
agreementsToggle.addEventListener('click', () => {
  const open = agreementsMore.hasAttribute('hidden');
  if (open) agreementsMore.removeAttribute('hidden'); else agreementsMore.setAttribute('hidden', '');
  agreementsToggle.classList.toggle('is-active', open);
  agreementsToggle.setAttribute('aria-expanded', String(open));
  agreementsToggle.textContent = open ? '收起' : '改';
});

// 负额（退款/冲抵）走「−¥8,000」而不是「¥-8,000」——记账惯例，符号在前
const fmt = (n) => (Number(n) < 0 ? '−¥' : '¥') + Math.abs(Number(n)).toLocaleString('en-US');
const CASE_STATUS = { shelved: '搁置', closed: '已结' };
let activeCases = [];
let filesEnabled = false;
let onlyOwing = false;
let currentCases = [];
let visibleCaseDetails = [];

async function openNewFee() {
  if (!activeCases.length) {
    toast('当前没有在办案件，请先建案或恢复案件状态');
    return;
  }
  const value = await datePrompt({
    title: '记一笔律师费款项',
    hint: '先记事实与收款条件；金额尚未确定时可以留空。',
    fields: [
      {
        key: 'case_id', label: '在办案件', type: 'select', required: true,
        options: [
          { value: '', label: '请选择案件' },
          ...activeCases.map((c) => ({ value: String(c.id), label: c.name })),
        ],
      },
      {
        key: 'label', label: '款项名称', type: 'text', required: true, placeholder: '如：签约首款',
        pattern: '.*\\S.*', title: '请输入至少一个非空白字符',
      },
      {
        key: 'amount', label: '金额（元）', type: 'text', inputmode: 'decimal', placeholder: '留空 = 金额待定',
        pattern: '(?:\\+|-)?(?:0|[1-9]\\d*)(?:\\.\\d{1,2})?', title: '请输入整数或最多两位小数',
      },
      { key: 'node', label: '收款条件', type: 'text', placeholder: '如：合同签订后 3 日内' },
      { key: 'due_on', label: '到期日', type: 'date' },
    ],
  });
  if (!value) return;
  const body = {
    label: value.label.trim(),
    node: value.node.trim(),
    due_on: value.due_on,
  };
  if (value.amount.trim()) body.amount = value.amount.trim();
  await api(`/cases/${value.case_id}/fees`, { body });
  toast('款项已记录 ✓');
  await load();
}

function feeEmptyState(message = '还没有任何款项记录') {
  return el('div', { class: 'section-empty fee-empty-action' },
    el('span', {}, `${message}。`),
    activeCases.length ? el('button', { class: 'btn small', type: 'button', onclick: openNewFee }, '记款项') : null,
    activeCases.length
      ? el('a', {
        class: 'btn small', href: `/case.html?id=${activeCases[0].id}#case-money`,
        title: `打开「${activeCases[0].name}」的律师费与分成区`,
      }, '到案件资金区')
      : el('a', { class: 'btn small', href: '/cases.html' }, '先去建案')
  );
}

// 案件的「已到期未收」= 该案 unpaid 且 due_on 已过的金额之和（由 overview 已有字段推导，不新增请求）
// 口径与 statusPill / 服务端 totals.overdue 一致：到期日「过了当日」才算已到期
function overdueOf(c, today) {
  return c.items.reduce(
    (s, f) => s + (f.status === 'unpaid' && f.amount != null && f.due_on && f.due_on < today ? f.amount : 0),
    0
  );
}

function signalRow(label, value, tone = '', isZero = Number(value) === 0) {
  return el('div', { class: `fee-signal-row${tone ? ` is-${tone}` : ''}${isZero ? ' is-zero' : ''}` },
    el('span', { class: 'fee-signal-label' }, label),
    el('span', { class: 'grow' }),
    el('b', { class: 'num fee-signal-value' }, typeof value === 'number' ? fmt(value) : value)
  );
}

function ledgerInlineTerm(label, value, tone = '') {
  return el('span', { class: `fee-ledger-inline${tone ? ` is-${tone}` : ''}` },
    el('span', { class: 'fee-ledger-inline-label' }, label),
    el('b', { class: 'num fee-ledger-inline-value' }, fmt(value))
  );
}

function ledgerHeadline(value) {
  const number = Number(value);
  return el('strong', { class: 'num fee-ledger-value' },
    el('span', { class: 'fee-ledger-currency' }, number < 0 ? '−¥' : '¥'),
    el('span', {}, Math.abs(number).toLocaleString('en-US'))
  );
}

// 第一层只回答“总账现在是多少、分成有没有算进去”。金额由后端给出，浏览器只排版，不复算。
function renderLedger(totals, cases, today) {
  const urgent = cases
    .map((c) => ({
      ...c,
      overdue: overdueOf(c, today),
      nextDue: c.items
        .filter((fee) => fee.status === 'unpaid' && fee.due_on)
        .sort((a, b) => a.due_on.localeCompare(b.due_on))[0],
    }))
    .filter((c) => c.overdue > 0 || c.nextDue)
    .sort((a, b) => (b.overdue - a.overdue)
      || String(a.nextDue?.due_on || '9999').localeCompare(String(b.nextDue?.due_on || '9999')))[0];
  const urgentDue = urgent?.nextDue?.due_on || '';
  const urgentDays = urgentDue
    ? Math.round((Date.parse(today) - Date.parse(urgentDue)) / 86_400_000)
    : 0;
  const urgentMeta = urgent
    ? `${urgent.case_name} · ${urgentDays > 0 ? `逾期 ${urgentDays} 日` : `${urgentDue} 到期`}`
    : '目前没有已到期待收';
  // 收缩态 mini：净额 + 要追（overlay 常驻 DOM，收起后由 CSS 淡入；aria-hidden，读屏走完整总账区）
  document.getElementById('ledger-mini').replaceChildren(
    el('span', { class: 'fee-mini-item' },
      el('span', { class: 'fee-mini-label' }, '净额'),
      el('b', { class: 'num' }, fmt(totals.net_retained))),
    el('a', {
      class: `fee-mini-item fee-mini-chase${totals.overdue ? ' is-overdue' : ''}`,
      href: urgent ? `/case.html?id=${urgent.case_id}#case-money` : '#fees-cases',
      tabindex: '-1',
    },
      el('span', { class: 'fee-mini-label' }, '要追'),
      el('b', { class: 'num' }, fmt(totals.overdue)))
  );
  document.getElementById('ledger-overview').replaceChildren(
    el('section', { class: 'fee-ledger', 'aria-label': '分成后总账净额' },
      el('div', { class: 'fee-ledger-lead' },
        el('div', { class: 'fee-ledger-topline' },
          el('div', { class: 'fee-ledger-kicker' }, '分成后总账净额 · 全期'),
          el('span', { class: 'chip c-green' }, '分成已计入')
        ),
        ledgerHeadline(totals.net_retained),
        el('div', { class: 'fee-ledger-equation' },
          ledgerInlineTerm('已收', totals.paid),
          el('span', { class: 'fee-ledger-op', 'aria-hidden': 'true' }, '−'),
          ledgerInlineTerm('应付分成', totals.share_payable, 'payable'),
          el('span', { class: 'fee-ledger-op', 'aria-hidden': 'true' }, '+'),
          ledgerInlineTerm('应收分成', totals.share_receivable, 'receivable')
        ),
        el('div', { class: 'fee-ledger-note' }, '仅已形成正式台账的分成参与；暂定约定与未确认方案不计入。')
      ),
      el('a', {
        class: `fee-chase${totals.overdue ? ' is-overdue' : ''}`,
        href: urgent ? `/case.html?id=${urgent.case_id}#case-money` : '#fees-cases',
      },
        el('span', { class: 'fee-ledger-kicker' }, '要追的钱'),
        el('b', { class: 'num' }, fmt(totals.overdue)),
        el('span', { class: 'fee-chase-meta' }, urgentMeta),
        el('span', { class: 'fee-chase-action' }, urgent ? '去催收' : '查看款项')
      )
    )
  );
}

// 状态 chip（账本行专用，规格 §3：padding 2px 7px、600 11px）：比 .pill 更紧凑。
function statusChip(f) {
  if (f.status === 'paid') return el('span', { class: 'ledger-chip is-ok' }, f.paid_on ? `已收 · ${f.paid_on}` : '已收');
  if (f.status === 'waived') return el('span', { class: 'ledger-chip is-muted' }, '减免');
  if (!f.due_on) return el('span', { class: 'ledger-chip is-muted' }, '待收 · 节点未到');
  const overdue = f.due_on < todayStr();
  return el('span', { class: `ledger-chip ${overdue ? 'is-crit' : 'is-warn'}` },
    overdue ? `逾期 · ${f.due_on}` : `待收 · ${f.due_on}`);
}

// 金额单元：退款（负额）不靠颜色单编码——「退款」chip + 减号双编码（色盲可读）
function amountNodes(f) {
  if (f.amount == null) return el('span', { class: 'meta' }, '（金额待定）');
  if (f.amount < 0) return [el('span', { class: 'chip c-red' }, '退款'), el('b', { class: 'num' }, fmt(f.amount))];
  return el('b', { class: 'num' }, fmt(f.amount));
}

// 款项账本行（规格 §3）：一行 6 列 = 款项/状态/触发节点/金额/分成/动作。
// 凭证给份数（0 份红字「缺」）；动作列只放「主按钮 + 到案件详情」两个按钮，
// 完整结算操作（这笔怎么分/减免/凭证管理）在案件详情页处理，不在费用台账行内堆叠。
// 状态列 116px：要装下「逾期 · 2026-04-27」这种带日期的 chip（600 11px 实测 ~111px），92px 会溢出压到触发节点列。
// 各列最小值合计须 ≤ 卡内可用宽（1440 视口实测 ~888px），否则动作列被卡片 overflow:hidden 裁掉。
const FEE_ITEM_GRID = 'minmax(170px,1.1fr) 116px minmax(120px,1fr) minmax(110px,1fr) minmax(80px,.7fr) 160px';
function itemRow(f, c) {
  const voucherCount = (f.vouchers || []).length;
  // 分成摘要：取首条 share 的方向+对象+金额，或「无分成」
  const firstShare = (f.shares || [])[0];
  const shareText = firstShare
    ? `${firstShare.direction === 'payable' ? '应付' : '应收'} ${firstShare.counterpart} ${fmt(firstShare.amount)}`
    : '无分成';
  // 主按钮：paid → 记分成；unpaid → 标记已收；waived → 无主按钮
  const primaryBtn = f.status === 'paid'
    ? el('button', { class: 'ledger-btn primary is-paid', type: 'button',
        onclick: () => openFeeSettlement({ fee: f, onChanged: load }) }, '记分成')
    : f.status === 'unpaid'
      ? el('button', { class: 'ledger-btn primary', type: 'button',
          onclick: () => openFeeSettlement({ fee: f, onChanged: load }) }, '标记已收')
      : null;
  return el('div', {
    class: 'ledger-item fee-ledger-item',
    style: `grid-template-columns:${FEE_ITEM_GRID}`,
  },
    el('span', { class: 'ledger-item-label', style: 'grid-column:1' }, f.label),
    el('span', { style: 'grid-column:2;justify-self:start' }, statusChip(f)),
    el('span', { class: 'ledger-item-node', style: 'grid-column:3' }, f.node || '未填写'),
    el('span', { class: 'ledger-item-amt', style: 'grid-column:4' }, amountNodes(f)),
    el('span', {
      class: `ledger-item-share${firstShare ? '' : ' is-faint'}`,
      style: 'grid-column:5',
      title: shareText,
    }, shareText),
    el('span', { class: 'ledger-item-acts', style: 'grid-column:6' },
      primaryBtn,
      el('a', {
        class: 'ledger-btn ghost',
        href: `/case.html?id=${c.case_id}#case-money`,
        title: '在案件详情页处理：改到期、减免、凭证、完整结算',
      }, '明细'),
    ),
  );
}

// 分成结果带：与款项主信息分层，避免实际台账、计划与操作挤在同一行。
function shareSubRow(s, fee) {
  const receivable = s.direction === 'receivable';
  const auditButton = s.settlement_snapshot_id
    ? el('button', {
      class: 'btn small fee-share-audit', type: 'button',
      'aria-label': `查看「${fee.label}」与「${s.counterpart}」这笔分成怎么算的`,
      onclick: () => openFeeSettlement({ fee, onChanged: load, initialSnapshotId: s.settlement_snapshot_id }),
    }, '怎么算的')
    : null;
  return el('div', { class: 'fee-share-result' },
    el('span', { class: 'fee-share-kicker' }, '分成结果'),
    el('span', { class: 'fee-share-main' },
      el('b', { class: 'num fee-share-amount' }, fmt(s.amount)),
      el('span', { class: `chip ${s.direction === 'payable' ? 'c-amber' : 'c-blue'}` }, s.direction === 'payable' ? '应付' : '应收'),
      el('b', { class: 'fee-share-party' }, s.counterpart),
      el('span', { class: `pill ${s.status === 'settled' ? 'ok' : 'warn'}` }, s.status === 'settled'
        ? (receivable ? '已收' : '已分')
        : (receivable ? '待收' : '待分')),
      !s.settlement_snapshot_id && ['manual', 'legacy'].includes(s.entry_kind)
        ? el('span', { class: 'meta' }, '人工直记') : null
    ),
    auditButton
  );
}

// 凭证附属区：款项行下方，含份数、上传、拖拽。filesEnabled=false 时只给份数行。
function voucherLine(f) {
  const count = (f.vouchers || []).length;
  return el('div', { class: 'fee-item-voucher-line' },
    el('span', { class: 'fee-item-kicker' }, '凭证'),
    count
      ? el('span', { class: 'meta' }, `${count} 份`)
      : el('span', { class: 'meta', style: 'color:var(--red-dot)' }, '缺'),
  );
}

function itemBlock(f, c) {
  const voucherBox = renderFeeVouchers(f, { enabled: filesEnabled, onChanged: load });
  return el('div', { class: 'fee-item-block' },
    itemRow(f, c),
    // 附属区：备注 + 分成结果带 + 凭证管理（给管理 UI 时不重复份数行）
    f.note
      ? el('div', { class: 'fee-item-note' },
        el('span', { class: 'fee-item-note-label' }, '备注'), f.note)
      : null,
    ...(f.shares || []).map((s) => shareSubRow(s, f)),
    voucherBox || (filesEnabled ? null : voucherLine(f)),
  );
}

function caseFooter(c) {
  return el('div', { class: 'p-foot' },
    el('span', { class: 'fk fee-case-net' }, '本案净额', el('b', { class: 'num' }, fmt(c.net_retained))),
    el('span', { class: 'fk' }, '律师费已收', el('b', { class: 'num' }, fmt(c.paid))),
    el('span', { class: 'fk' }, '待收', el('b', { class: 'num' }, fmt(c.unpaid))),
    c.waived ? el('span', { class: 'fk' }, '放弃 / 减免', el('b', { class: 'num' }, fmt(c.waived))) : null,
    c.tbd ? el('span', { class: 'fk' }, '金额待定', el('b', { class: 'num' }, `${c.tbd} 项`)) : null,
    c.shares?.payable ? el('span', { class: 'fk' }, '应付分成', el('b', { class: 'num' }, fmt(c.shares.payable))) : null,
    c.shares?.receivable ? el('span', { class: 'fk' }, '应收分成', el('b', { class: 'num' }, fmt(c.shares.receivable))) : null,
    el('span', { class: 'tail' }, `${c.items.length} 项款项`),
    el('a', { class: 'btn small', href: `/case.html?id=${c.case_id}#case-money` }, '打开本案资金区')
  );
}

function caseMeta(c) {
  return el('span', { class: 'p-meta' },
    c.case_status !== 'active' && CASE_STATUS[c.case_status] ? el('span', {}, CASE_STATUS[c.case_status]) : null,
    c.over > 0 ? el('span', { class: 'm hot' }, `已到期 ${fmt(c.over)}`) : null
  );
}

// 账本表头（规格 §3 表头）：箭头 / 案件+程序 / 进度条 / 已收 / 待收 / 其中逾期 / 款项数
// 数字列表头右对齐，否则收起态的数字列没有锚。
const CASE_GRID = '18px minmax(200px,1fr) 108px 108px 108px 108px 62px';
function ledgerHeader() {
  return el('div', { class: 'ledger-head', style: `grid-template-columns:${CASE_GRID}` },
    el('span', { style: 'grid-column:1' }),
    el('span', { style: 'grid-column:2' }, '案件'),
    el('span', { style: 'grid-column:3' }, '收款进度'),
    el('span', { class: 'is-num', style: 'grid-column:4' }, '已收'),
    el('span', { class: 'is-num', style: 'grid-column:5' }, '待收'),
    el('span', { class: 'is-num', style: 'grid-column:6' }, '其中逾期'),
    el('span', { class: 'is-num', style: 'grid-column:7' }, '款项数'),
  );
}

// 账本行收起态（规格 §3）：一行 7 列数据行，点整行展开/收起。
// 进度条：已收段 ok-dot opacity .5；待收段 逾期红/正常琥珀 opacity .45。
function caseLedgerRow(c, index) {
  const total = Math.max(0, c.paid) + Math.max(0, c.unpaid);
  const isOpen = false; // 开合态由 details.ledger-group 的 [open] 决定，这里只画收起态
  return el('summary', {
    class: 'ledger-row fee-ledger-row',
    style: `grid-template-columns:${CASE_GRID}`,
  },
    el('span', { class: 'ledger-caret', style: 'grid-column:1', 'data-caret': '' }, '▸'),
    el('span', { class: 'ledger-name', style: 'grid-column:2;display:flex;align-items:baseline;gap:8px;min-width:0' },
      el('span', { style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, c.case_name),
      c.stage ? el('span', { class: 'ledger-stage' }, c.stage) : null,
    ),
    el('span', { class: 'ledger-bar', style: 'grid-column:3', role: 'img', 'aria-label': `律师费已收 ${fmt(c.paid)}，待收 ${fmt(c.unpaid)}` },
      total ? el('span', { class: 'is-paid', style: `flex:${Math.max(0,c.paid) || 0}` }) : null,
      total ? el('span', { class: `is-unpaid ${c.over > 0 ? 'danger' : 'warn'}`, style: `flex:${Math.max(0,c.unpaid) || 0}` }) : null,
    ),
    el('span', { class: 'ledger-num', style: 'grid-column:4;justify-self:end;font:500 12.5px/1 var(--f-num);color:var(--ink-2)' }, fmt(c.paid)),
    el('span', { class: 'ledger-num', style: `grid-column:5;justify-self:end;font:${c.unpaid ? 600 : 400} 12.5px/1 var(--f-num);color:${c.unpaid ? 'var(--ink)' : 'var(--faint)'}` },
      c.unpaid ? fmt(c.unpaid) : '—'),
    c.over
      ? el('span', { class: 'ledger-num', style: 'grid-column:6;justify-self:end;font:600 12.5px/1 var(--f-num);color:var(--red-dot)' }, fmt(c.over))
      : el('span', { style: 'grid-column:6;visibility:hidden' }),
    el('span', { style: 'grid-column:7;justify-self:end;font:450 11.5px/1.5 var(--sans);color:var(--faint);white-space:nowrap' }, `${c.items.length} 项`),
  );
}

// 所有案件同一套原生折叠：有逾期款项的案件强制首屏展开，其余按本机状态记忆。
// 现在是账本行：一组连续的表，需要处理的（over>0）自己展开。
function caseLedgerGroup(c, index) {
  const items = el('div', { class: 'fee-items' }, c.items.map((f) => itemBlock(f, c)));
  const details = el('details', {
    class: `ledger-group fee-ledger-group${c.over > 0 ? ' is-over' : ' is-ok'}`,
  },
    caseLedgerRow(c, index),
    items,
    caseFooter(c),
  );
  bindFold(details, `fee-case-${c.case_id}`, c.over > 0, { forceOpen: c.over > 0 });
  // 开合时同步 caret 文字与计数（caret 用 textContent，避免依赖 CSS rotate）
  const syncCaret = () => {
    const caret = details.querySelector('[data-caret]');
    if (caret) caret.textContent = details.open ? '▾' : '▸';
    details.classList.toggle('is-open', details.open);
    const count = visibleCaseDetails.filter((item) => item.open).length;
    const countNode = document.getElementById('fee-case-count');
    if (countNode) countNode.textContent = `${visibleCaseDetails.length} 案 · 展开 ${count}`;
  };
  details.addEventListener('toggle', syncCaret);
  syncCaret();
  return details;
}

// 归档门（规格 §5 实底变体）：已结案且无未结款项的案子从表里移出，收进表底。
function renderArchiveDoor(closedCases) {
  if (!closedCases.length) return null;
  const count = closedCases.length;
  const netTotal = closedCases.reduce((s, c) => s + Math.max(0, Number(c.net_retained) || 0), 0);
  const details = el('details', {
    class: 'archive-door is-solid fee-archive',
    'data-fold-id': 'fees-closed',
  },
    el('summary', { class: 'archive-door-summary' },
      el('span', { class: 'archive-door-caret' }, '▸'),
      el('span', { class: 'archive-door-text' }, '已结案且无未结款项'),
      el('span', { class: 'archive-door-count' }, `${count} 件 · 净额合计 ${fmt(netTotal)}`),
    ),
    el('div', { class: 'archive-door-body' },
      ...closedCases.map((c, i) => el('div', { class: 'archive-door-row' },
        el('span', { class: 'archive-door-key' }, c.case_name),
        el('span', { class: 'archive-door-val' }, `${c.items.length} 项款项 · 净额 ${fmt(c.net_retained)}`),
      )),
    ),
  );
  bindFold(details, 'fees-closed', false);
  const syncCaret = () => {
    const caret = details.querySelector('.archive-door-caret');
    if (caret) caret.textContent = details.open ? '▾' : '▸';
  };
  details.addEventListener('toggle', syncCaret);
  syncCaret();
  return details;
}

function shareDirection(direction) {
  return el('span', { class: `chip ${direction === 'payable' ? 'c-amber' : 'c-blue'}` },
    direction === 'payable' ? '应付' : '应收');
}

function shareAmountNodes(s) {
  const amount = el('b', { class: 'num' }, fmt(s.amount));
  return Number(s.amount) < 0 ? [el('span', { class: 'chip c-red' }, '冲抵'), amount] : [amount];
}

function shareStatus(s, today) {
  const receivable = s.direction === 'receivable';
  const overdue = s.due_month < today.slice(0, 7);
  return el('span', { class: `pill ${overdue ? 'crit' : 'warn'}` },
    overdue
      ? `${receivable ? '待收' : '待分'} · 逾期（${s.due_month}）`
      : `${receivable ? '待收' : '待分'} · ${s.due_month}`);
}

function shareItemRow(s, today) {
  const caseNode = s.case_id
    ? el('a', { class: 'grow', href: `/case.html?id=${s.case_id}#case-money` }, s.case_name || '未命名案件')
    : el('span', { class: 'grow' }, s.external_case || '外部案件');
  const feeChip = s.fee_label ? el('span', { class: 'chip' }, '← ' + s.fee_label) : null;
  return el('div', { class: 'row' },
    caseNode,
    feeChip,
    shareDirection(s.direction),
    shareStatus(s, today),
    ...shareAmountNodes(s),
    el('span', { class: 'meta' }, s.note || ''),
    el('span', { class: 'tl-actions' },
      el('button', {
        class: 'btn small primary', type: 'button',
        onclick: async () => {
          const receivable = s.direction === 'receivable';
          const v = await datePrompt({
            title: receivable ? `已收到「${s.counterpart}」给我的分成` : `已向「${s.counterpart}」完成分成`,
            fields: [{ key: 'settled_on', label: receivable ? '收款日期' : '分成日期', value: todayStr(), required: true }],
          });
          if (!v) return;
          await api(`/shares/${s.id}`, { method: 'PATCH', body: { status: 'settled', settled_on: v.settled_on } });
          toast(receivable ? '已标记收款 ✓' : '已标记分成完成 ✓');
          load();
        },
      }, s.direction === 'receivable' ? '已收' : '已分'),
      el('button', {
        class: 'btn small', type: 'button',
        onclick: async () => {
          const receivable = s.direction === 'receivable';
          const v = await datePrompt({
            title: `修改与「${s.counterpart}」的${receivable ? '应收' : '应分'}月份`,
            fields: [{
              key: 'due_month', label: receivable ? '应收月份' : '应分月份',
              value: s.due_month, type: 'month', required: true,
            }],
          });
          if (!v || v.due_month === s.due_month) return;
          await api(`/shares/${s.id}`, { method: 'PATCH', body: { due_month: v.due_month } });
          toast(`${receivable ? '应收' : '应分'}月份已更新 ✓`);
          await load();
        },
      }, '改月份')
    )
  );
}

function shareSettledText(s) {
  return s.direction === 'receivable' ? '本年已收' : '本年已分';
}

function settledShareRow(s) {
  const receivable = s.direction === 'receivable';
  const caseNode = s.case_id
    ? el('a', { class: 'grow', href: `/case.html?id=${s.case_id}#case-money` }, s.case_name || '未命名案件')
    : el('span', { class: 'grow' }, s.external_case || '外部案件');
  return el('div', { class: 'row share-settled-row' },
    caseNode,
    s.fee_label ? el('span', { class: 'chip' }, '← ' + s.fee_label) : null,
    shareDirection(s.direction),
    el('span', { class: 'pill ok' }, `${receivable ? '已收' : '已分'} · ${s.settled_on || '日期未记'}`),
    ...shareAmountNodes(s),
    s.note ? el('span', { class: 'meta' }, s.note) : null
  );
}

function counterpartBlock(g, items, today) {
  const pending = items.filter((s) => s.counterpart === g.counterpart && s.status === 'pending');
  const year = today.slice(0, 4);
  const settled = items.filter((s) => s.counterpart === g.counterpart
    && s.status === 'settled' && s.settled_on?.startsWith(year));
  const settledLabel = new Set(settled.map(shareSettledText)).size === 1
    ? shareSettledText(settled[0] || { direction: 'payable' })
    : '本年已结';
  const settledTotal = settled.reduce((sum, s) => sum + Number(s.amount || 0), 0);
  const top = el('div', { class: 'row' },
    el('b', {}, g.counterpart),
    el('span', { class: 'grow meta' }, g.pending_count ? `${g.pending_count} 笔待处理` : '无待处理'),
    g.payable_pending ? shareDirection('payable') : null,
    g.payable_pending ? el('b', { class: 'num' }, fmt(g.payable_pending)) : null,
    g.receivable_pending ? shareDirection('receivable') : null,
    g.receivable_pending ? el('b', { class: 'num' }, fmt(g.receivable_pending)) : null
  );
  const settledHistory = settled.length
    ? el('details', { class: 'share-settled-group' },
      el('summary', {
        class: 'row share-settled-summary',
        'aria-label': `${g.counterpart}：${settledLabel} ${settled.length} 笔，${fmt(settledTotal)}`,
      },
        el('span', { class: 'grow' }, `${settledLabel} · ${settled.length} 笔`),
        el('b', { class: 'num' }, fmt(settledTotal))
      ),
      ...settled.map(settledShareRow)
    )
    : null;
  return [top, ...pending.map((s) => shareItemRow(s, today)), ...(settledHistory ? [settledHistory] : [])];
}

function agreementOverviewRow(agreement) {
  const active = agreement.status === 'active';
  const latest = agreement.latest_revision;
  const view = latest?.money_view;
  const relation = agreement.direction === 'receivable'
    ? `${agreement.counterpart}应给我`
    : `我应给${agreement.counterpart}`;
  return el('article', { class: `money-card is-${agreement.direction}${active ? '' : ' is-retired'}` },
    el('div', { class: 'money-card-head' },
      el('div', { class: 'grow' },
        el('a', { class: 'money-relation', href: `/case.html?id=${agreement.case_id}#case-money` }, relation),
        el('div', { class: 'money-summary' }, `${agreement.case_name || '未命名案件'} · ${view?.human_summary || '分成办法待补充'}`)
      ),
      el('div', { class: 'money-headline' },
        el('b', { class: 'num' }, view?.headline_text || '待定'),
        el('span', { class: `pill ${view?.provisional ? 'warn' : active ? 'ok' : ''}` }, active ? (view?.provisional ? '暂定' : '有效') : '已停用')
      )
    ),
    view?.pending_message ? el('div', { class: 'money-notice' }, view.pending_message) : null,
    el('div', { class: 'money-facts' },
      el('span', {}, '结算时间', el('b', {}, agreement.settlement_term || '待确定')),
      agreement.note ? el('span', {}, '补充说明', el('b', {}, agreement.note)) : null
    ),
    el('div', { class: 'money-next' },
      el('span', { class: 'meta' }, view?.provisional
        ? '扣费和实际分成基数明确后再完善'
        : (agreement.direction === 'payable' ? '在具体律师费行确认是否参与' : '实际分成基数形成后记应收')),
      el('a', { class: 'btn small primary', href: `/case.html?id=${agreement.case_id}#case-money` }, view?.provisional ? '完善扣费' : '查看案件资金')
    )
  );
}

function renderAgreementOverview(agreements = []) {
  const box = document.getElementById('share-agreement-rows');
  const receivable = agreements.filter((agreement) => agreement.direction === 'receivable');
  const payable = agreements.filter((agreement) => agreement.direction === 'payable');
  const activeReceivable = receivable.filter((agreement) => agreement.status === 'active').length;
  const activePayable = payable.filter((agreement) => agreement.status === 'active').length;
  document.getElementById('fees-agreements-summary').textContent =
    `${activeReceivable + activePayable} 条有效 · 应付 ${activePayable} 条 / 应收 ${activeReceivable} 条`;
  const group = (direction, rows) => el('section', { class: `settlement-agreement-group is-${direction}` },
    el('div', { class: 'settlement-agreement-group-head' },
      shareDirection(direction),
      el('b', {}, direction === 'receivable' ? '别人应给我的分成约定' : '我应给别人的分成约定'),
      el('span', { class: 'meta' }, `${rows.filter((row) => row.status === 'active').length} 条有效`)
    ),
    rows.length
      ? rows.map(agreementOverviewRow)
      : el('div', { class: 'section-empty' }, direction === 'receivable'
        ? '尚未登记别人应给我的分成约定'
        : '尚未登记我应给别人的分成约定')
  );
  box.replaceChildren(group('receivable', receivable), group('payable', payable));
}

function renderCasePanels() {
  const detail = document.getElementById('detail');
  // 已结案且无未结款项 → 归档；其余 → 在办账本表
  const closedCases = currentCases.filter((c) => c.case_status === 'closed' && !(c.unpaid > 0));
  let activeCases = currentCases.filter((c) => !(c.case_status === 'closed' && !(c.unpaid > 0)));
  if (onlyOwing) activeCases = activeCases.filter((c) => c.unpaid > 0);
  visibleCaseDetails = activeCases.map((c, index) => caseLedgerGroup(c, index));

  const nodes = [];
  if (visibleCaseDetails.length) {
    nodes.push(el('div', { class: 'ledger-table fee-ledger-table' },
      ledgerHeader(),
      ...visibleCaseDetails,
    ));
  }
  const archive = renderArchiveDoor(closedCases);
  if (archive) nodes.push(archive);
  if (!visibleCaseDetails.length && !archive) {
    nodes.push(el('section', { class: 'panel' }, feeEmptyState(
      onlyOwing ? '当前没有待收款项' : '还没有任何案件款项记录'
    )));
  }
  detail.replaceChildren(...nodes);

  const openCount = visibleCaseDetails.filter((d) => d.open).length;
  document.getElementById('fee-case-count').textContent = `${activeCases.length} 案 · 展开 ${openCount}`;
  const onlyButton = document.getElementById('fee-only-owing');
  onlyButton.setAttribute('aria-pressed', String(onlyOwing));
  onlyButton.textContent = onlyOwing ? '只看有待收 ✓' : '只看有待收';
}

// 「只留逾期展开」= 清本页所有 fold 记忆回到默认（仅 over>0 展开）
function setDefaultFolds() {
  for (const details of visibleCaseDetails) {
    const c = activeCases.find((ac) => details.dataset.foldId === `fee-case-${ac.case_id}`)
      || currentCases.find((cc) => details.dataset.foldId === `fee-case-${cc.case_id}`);
    setFoldOpen(details, c ? c.over > 0 : false);
  }
  const openCount = visibleCaseDetails.filter((d) => d.open).length;
  document.getElementById('fee-case-count').textContent = `${visibleCaseDetails.length} 案 · 展开 ${openCount}`;
}

function setAllCaseFolds(open) {
  for (const details of visibleCaseDetails) setFoldOpen(details, open);
  document.getElementById('fee-case-count').textContent =
    `${visibleCaseDetails.length} 案 · 展开 ${open ? visibleCaseDetails.length : 0}`;
}

function renderShares(s) {
  renderAgreementOverview(s.agreements || []);
  const box = document.getElementById('share-rows');
  box.replaceChildren(...s.by_counterpart.flatMap((g) => counterpartBlock(g, s.items, s.date)));
  if (!s.by_counterpart.length) box.append(el('div', { class: 'section-empty' }, '还没有分成记录'));

  const pendingCount = s.items.filter((x) => x.status === 'pending').length;
  const activeAgreements = (s.agreements || []).filter((agreement) => agreement.status === 'active').length;
  document.getElementById('share-meta').textContent = `${activeAgreements} 条有效约定 · ${pendingCount} 笔待处理`;
  document.getElementById('share-payable').textContent = fmt(s.totals.payable_pending);
  document.getElementById('share-receivable').textContent = fmt(s.totals.receivable_pending);
  document.getElementById('share-foot').hidden = !s.items.length;
}

async function load() {
  const [d, shares, repairs, casesForEntry] = await Promise.all([
    api('/fees/overview'),
    api('/shares/overview'),
    api('/share-repairs?status=open'),
    api('/cases?status=active'),
  ]);
  activeCases = casesForEntry;
  filesEnabled = Boolean(d.files_enabled);
  const repairLink = document.getElementById('share-repairs-link');
  repairLink.textContent = repairs.length ? `修复历史分成 · ${repairs.length}` : '修复历史分成';
  repairLink.title = repairs.length ? `有 ${repairs.length} 笔待裁决的历史分成` : '查看历史分成修复工作台';
  const today = d.date || todayStr();
  const cases = d.cases.map((c) => ({ ...c, over: overdueOf(c, today) }));

  document.getElementById('subtitle').textContent = `截至 ${d.date} · 全期权责口径`;

  renderLedger(d.totals, cases, today);
  document.getElementById('fee-signals').replaceChildren(
    signalRow('待收', d.totals.unpaid, d.totals.unpaid ? 'warn' : ''),
    signalRow('其中已到期', d.totals.overdue, d.totals.overdue ? 'crit' : ''),
    signalRow('放弃 / 减免', d.totals.waived),
    signalRow('金额待定项', `${d.totals.tbd} 项`, '', !d.totals.tbd)
  );

  // ── 款项明细 ──
  currentCases = cases;
  renderCasePanels();

  renderShares(shares);
}

// ── 粘性抬头下滑收缩 ──
// 把抬头的 sticky top 设为「顶栏高 − 导航行在抬头内的 offsetTop」：标题与总账大数字
// 随滚动自然滚走（藏进 z-60 顶栏后面），最终只剩锚点导航行钉在顶栏下。
// 收缩量由 ResizeObserver 量取（总账高度随数据/断点变化）；is-condensed 只控制 mini overlay
// 的淡入——overlay 不占布局高度，所以整个过程无内容跳动、无阈值抖动循环。
const feeContextHeader = document.querySelector('.fee-context-header');
const feeSectionNav = feeContextHeader.querySelector('.section-nav');
let feeHeaderShrink = 0;
const syncHeaderCondensed = () => {
  feeContextHeader.classList.toggle('is-condensed', window.scrollY >= feeHeaderShrink - 4);
};
new ResizeObserver(() => {
  feeHeaderShrink = Math.max(0, Math.round(feeSectionNav.offsetTop));
  feeContextHeader.style.top = `calc(var(--h-top) - ${feeHeaderShrink}px)`;
  syncHeaderCondensed();
}).observe(feeContextHeader);
addEventListener('scroll', syncHeaderCondensed, { passive: true });

document.getElementById('fee-add').addEventListener('click', openNewFee);
document.getElementById('fee-only-owing').addEventListener('click', () => {
  onlyOwing = !onlyOwing;
  renderCasePanels();
});
document.getElementById('fee-collapse-all').addEventListener('click', setDefaultFolds);
const expandAllBtn = document.getElementById('fee-expand-all');
if (expandAllBtn) expandAllBtn.remove();
document.addEventListener('anjian:changed', load);
await load();
