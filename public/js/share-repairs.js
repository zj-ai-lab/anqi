// 历史分成修复工作台：只展示人工裁决所需的原分成、同案已收候选和软重复参照。
// 不做自动匹配/合并/删除/重算；所有实际裁决仍由 /api/share-repairs 的事务端点执行。
import { el, toast } from './api.js';
import { mountNav } from './nav.js';
import { datePrompt } from './dateedit.js';
import { bindFold } from './fold.js';

await mountNav();

const fmt = (n) => (Number(n) < 0 ? '−¥' : '¥') + Math.abs(Number(n)).toLocaleString('zh-CN');
const DIRECTION = { payable: '应付', receivable: '应收' };
const RESOLUTION = {
  claimed: '已认领来源款',
  retained_unlinked: '已保留未认领',
  voided_duplicate: '已逻辑作废',
};

function directionChip(direction) {
  return el('span', { class: `chip ${direction === 'payable' ? 'c-amber' : 'c-blue'}` }, DIRECTION[direction] || direction);
}

function statusPill(status) {
  if (status === 'open') return el('span', { class: 'pill warn' }, '待修复');
  if (status === 'voided_duplicate') return el('span', { class: 'pill crit' }, RESOLUTION[status]);
  return el('span', { class: 'pill ok' }, RESOLUTION[status] || status);
}

function candidateLabel(fee) {
  const date = fee.paid_on || '收款日未填';
  const amount = fee.amount == null ? '金额待定' : fmt(fee.amount);
  return `${date} · ${fee.label} · ${amount}`;
}

async function postRepair(repair, action, body) {
  const res = await fetch(`/api/share-repairs/${repair.id}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    location.href = '/login.html';
    return null;
  }
  let data = {};
  try { data = await res.json(); } catch { /* response errors still get a usable message below */ }
  if (!res.ok) {
    if (data.code === 'source_claim_conflict') return { conflict: data };
    toast('❌ ' + (data.error || `HTTP ${res.status}`));
    return null;
  }
  return data;
}

async function claimRepair(repair, feeItemId, afterConflict = false) {
  const hasSoftDuplicate = afterConflict || repair.soft_duplicates.length > 0;
  let fields;
  let hint;
  if (hasSoftDuplicate) {
    const refCount = repair.soft_duplicates.length || 1;
    if (!confirm(`发现 ${refCount} 笔可能重复的分成参照。它们只作软提示，不会自动合并或作废。确认本笔独立后继续认领？`)) return;
    hint = '明确确认独立性，并填写例外理由；系统才会将既有同案已收款关联到这笔历史分成。';
    fields = [
      { key: 'resolution_note', label: '认领说明', type: 'text', required: true, placeholder: '人工核对的依据' },
      { key: 'exception_reason', label: '独立例外理由', type: 'text', required: true, placeholder: '为何不是重复记录' },
    ];
  } else {
    hint = '只关联既有同案已收款；不会更改分成金额、状态或计算规则。';
    fields = [{ key: 'resolution_note', label: '认领说明', type: 'text', required: true, placeholder: '人工核对的依据' }];
  }
  const values = await datePrompt({ title: '认领历史分成的来源款', hint, fields });
  if (!values) return;

  const result = await postRepair(repair, 'claim', {
    fee_item_id: Number(feeItemId),
    version: repair.version,
    resolution_note: values.resolution_note,
    ...(hasSoftDuplicate ? { confirm_independent: true, exception_reason: values.exception_reason } : {}),
  });
  if (result?.conflict && !hasSoftDuplicate) {
    toast('发现可能重复的参照，请明确确认独立性后重试');
    await claimRepair(repair, feeItemId, true);
    return;
  }
  if (result?.repair) {
    toast('已认领来源款 ✓');
    await load();
  }
}

async function retainRepair(repair) {
  const values = await datePrompt({
    title: '保留未认领历史分成',
    hint: '这会关闭本修复单，但原分成继续保持未挂来源款；不会删除或重算。',
    fields: [{ key: 'resolution_note', label: '保留理由', type: 'text', required: true, placeholder: '人工判断依据' }],
  });
  if (!values) return;
  const result = await postRepair(repair, 'retain', {
    version: repair.version,
    resolution_note: values.resolution_note,
  });
  if (result?.repair) {
    toast('已保留未认领 ✓');
    await load();
  }
}

async function voidRepair(repair) {
  const values = await datePrompt({
    title: '逻辑作废历史分成',
    hint: '只用于重复或录入错误。原行会保留为审计证据，但不再计入总账、统计、提醒或正常列表。',
    fields: [{ key: 'resolution_note', label: '作废理由', type: 'text', required: true, placeholder: '重复或录入错误的人工依据' }],
  });
  if (!values) return;
  if (!confirm('确认将此分成逻辑作废？此操作不可通过普通分成编辑恢复。')) return;
  const result = await postRepair(repair, 'void', {
    version: repair.version,
    resolution_note: values.resolution_note,
  });
  if (result?.repair) {
    toast('已逻辑作废 ✓');
    await load();
  }
}

function duplicateReferences(rows) {
  if (!rows.length) return null;
  return el('div', { class: 'row' },
    el('span', { class: 'chip c-amber' }, `可能重复 ${rows.length} 笔`),
    el('span', { class: 'grow meta' }, '同案、方向、合作对象、金额和应分月相同仅作软提示；绝不自动合并或写库。'),
    ...rows.map((row) => el('span', { class: 'chip' }, `参照 #${row.id}${row.fee_label ? ` · ${row.fee_label}` : ''}`))
  );
}

function openRepairBody(repair) {
  const candidates = repair.fee_candidates || [];
  const select = el('select', { 'aria-label': `选择修复单 #${repair.id} 的来源款项` },
    el('option', { value: '' }, candidates.length ? '请选择同案已收款项' : '本案暂无已收款项'),
    ...candidates.map((fee) => el('option', { value: fee.id }, candidateLabel(fee)))
  );
  const claim = el('button', {
    class: 'btn small primary', type: 'button',
    onclick: async () => {
      if (!select.value) { toast('请先选择同案已收款项'); return; }
      await claimRepair(repair, select.value);
    },
  }, '认领来源款');
  return [
    el('div', { class: 'row' },
      el('span', { class: 'grow meta' }, '同案已收款候选'),
      select,
      claim
    ),
    duplicateReferences(repair.soft_duplicates || []),
    el('div', { class: 'p-foot' },
      el('span', { class: 'meta' }, '认领、保留或作废均须人工填写理由。'),
      el('span', { class: 'tail tl-actions' },
        el('button', { class: 'btn small', type: 'button', onclick: () => retainRepair(repair) }, '保留未认领'),
        el('button', { class: 'btn small danger', type: 'button', onclick: () => voidRepair(repair) }, '作废重复')
      )
    ),
  ].filter(Boolean);
}

function resolvedRepairBody(repair) {
  const items = [];
  if (repair.share.fee_label) {
    items.push(el('span', { class: 'chip' }, '来源款：' + repair.share.fee_label));
  }
  if (repair.resolution_note) {
    items.push(el('span', { class: 'grow meta' }, `裁决理由：${repair.resolution_note}`));
  }
  if (repair.exception_reason) {
    items.push(el('span', { class: 'meta' }, `独立例外：${repair.exception_reason}`));
  }
  if (!items.length) items.push(el('span', { class: 'meta' }, '未留下裁决说明'));
  return [el('div', { class: 'p-foot' }, ...items)];
}

function repairPanel(repair) {
  const share = repair.share;
  const caseLink = el('a', { class: 'grow', href: `/case.html?id=${share.case_id}` }, share.case_name);
  const source = [
    `应分 ${share.due_month}`,
    share.fee_item_id ? '已关联来源款' : '历史未挂来源款',
  ].join(' · ');
  const body = repair.status === 'open' ? openRepairBody(repair) : resolvedRepairBody(repair);
  return el('section', { class: 'panel', id: `repair-${repair.id}` },
    el('div', { class: 'p-head' },
      el('h2', { class: 'p-title' }, `修复单 #${repair.id}`),
      el('span', { class: 'p-meta' }, statusPill(repair.status))
    ),
    el('div', { class: 'row' },
      caseLink,
      directionChip(share.direction),
      el('b', {}, share.counterpart),
      el('b', { class: 'num' }, fmt(share.amount)),
      el('span', { class: 'pill warn' }, '已结历史行')
    ),
    el('div', { class: 'row' },
      el('span', { class: 'grow meta' }, source),
      el('span', { class: 'chip' }, `问题：${repair.issue_code}`),
      el('span', { class: 'meta' }, `版本 ${repair.version}`)
    ),
    ...body
  );
}

function syncHash() {
  const targetId = decodeURIComponent(location.hash.slice(1));
  if (!targetId) return;
  const target = document.getElementById(targetId);
  if (target) target.scrollIntoView({ block: 'start' });
}

async function load() {
  const status = document.getElementById('repair-status').value;
  // 默认视图（待裁决）拉「全部」：待修复渲染为主体、已修复进归档门（规格 §03.H）。
  // 用户主动选特定状态时，只看那个状态，不叠归档门。
  const fetchStatus = status === 'open' ? 'all' : status;
  const rows = await fetch(`/api/share-repairs?status=${encodeURIComponent(fetchStatus)}`)
    .then(async (res) => {
      if (res.status === 401) { location.href = '/login.html'; return []; }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      return res.json();
    })
    .catch((error) => { toast('❌ ' + error.message); return []; });
  const list = document.getElementById('repair-list');
  // 默认视图：主体 = open，归档 = 非 open；其他状态视图：主体 = 该状态全部，无归档
  const isDefaultView = status === 'open';
  const openRows = isDefaultView ? rows.filter((r) => r.status === 'open') : rows;
  const resolvedRows = isDefaultView ? rows.filter((r) => r.status !== 'open') : [];
  const nodes = openRows.map(repairPanel);
  if (resolvedRows.length) {
    // 归档门（规格 §03.H）：虚线框，本页唯一箭头，永远放最后
    const history = el('details', { class: 'archive-door repair-history-fold' },
      el('summary', { class: 'archive-door-summary' },
        el('span', { class: 'archive-door-caret' }, '▸'),
        el('span', { class: 'archive-door-text' }, '已完成的修复'),
        el('span', { class: 'archive-door-count' }, `已修复 ${resolvedRows.length} 条`),
      ),
      el('div', { class: 'archive-door-body' },
        el('div', { class: 'repair-history-list' }, ...resolvedRows.map(repairPanel))
      ),
    );
    bindFold(history, 'share-repairs-resolved', false);
    history.addEventListener('toggle', () => {
      const caret = history.querySelector('.archive-door-caret');
      if (caret) caret.textContent = history.open ? '▾' : '▸';
    });
    nodes.push(history);
  }
  list.replaceChildren(...nodes);
  if (!openRows.length && !resolvedRows.length) {
    list.append(el('div', { class: 'section-empty' }, status === 'open' ? '没有待裁决的历史分成' : '没有符合该状态的修复记录'));
  }
  document.getElementById('repair-meta').textContent = openRows.length ? `${openRows.length} 笔` : '';
  syncHash();
}

document.getElementById('repair-status').addEventListener('change', load);
window.addEventListener('hashchange', syncHash);
await load();
