import { api, el, toast, todayStr } from './api.js';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const RUN_LABEL = { receipt: '收款记账', correction: '修改结算', reversal: '撤销收款' };
const DIRECTION_LABEL = { payable: '我应付', receivable: '我应收' };
const BASIS_LABEL = { gross: '原始收费', remaining: '扣减后余额' };

function directionCopy(direction) {
  return direction === 'receivable'
    ? {
        title: '记我应收的分成约定',
        hint: '记录别人应给我的分成。金额或扣费尚未确定时，先记比例和待确定项，以后再完善分法。',
        counterpart: '主办律师 / 应付款方',
        counterpartPlaceholder: '如：李律师',
        notePlaceholder: '如：暂按 30% 记录，扣税、律所费用待后续确定',
        changePlaceholder: '如：先记录暂定比例，前置扣费方案待确定',
        status: '这里只保存分成约定，不会提前制造金额未知的应收账；实际基数或金额明确后再记入台账。',
        submit: '建立应收约定',
        success: '应收分成约定已建立 ✓',
      }
    : {
        title: '记我应付的分成约定',
        hint: '记录我收到律师费后应分给对方的安排；以后调整分法时，系统会保留历史。',
        counterpart: '合作律师 / 收款方',
        counterpartPlaceholder: '如：合作律师姓名',
        notePlaceholder: '合作范围 / 约定背景',
        changePlaceholder: '说明首次约定依据',
        status: '这里只保存分成约定；具体律师费到账时，再确认这笔钱是否参与。',
        submit: '建立应付约定',
        success: '应付分成约定已建立 ✓',
      };
}

function inputOf({ type = 'text', value = '', ...attrs } = {}) {
  const input = el('input', { type, ...attrs });
  input.value = value ?? '';
  return input;
}

function selectOf(options, value = '') {
  const select = el('select');
  for (const option of options) {
    select.append(el('option', { value: option.value }, option.label));
  }
  select.value = value ?? '';
  return select;
}

function field(label, control, cls = '') {
  return el('label', { class: `f${cls ? ` ${cls}` : ''}` }, label, control);
}

function parseScaledDecimal(value, scale, label, { allowNegative = true, allowZero = true } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error(`${label}不能为空`);
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error(`${label}格式不正确`);
  if (!allowNegative && match[1] === '-') throw new Error(`${label}不能为负数`);
  const fraction = match[3] || '';
  if (fraction.length > scale) throw new Error(`${label}最多 ${scale} 位小数`);
  const factor = 10n ** BigInt(scale);
  let result = BigInt(match[2]) * factor + BigInt(fraction.padEnd(scale, '0') || '0');
  if (match[1] === '-') result = -result;
  if (!allowZero && result === 0n) throw new Error(`${label}必须大于 0`);
  if (result > MAX_SAFE || result < -MAX_SAFE) throw new Error(`${label}超出安全范围`);
  return Number(result);
}

function parseMoneyToFen(value, label = '金额', options = {}) {
  return parseScaledDecimal(value, 2, label, options);
}

function parsePercentToBps(value, label = '比例') {
  const bps = parseScaledDecimal(value, 2, label, { allowNegative: false, allowZero: false });
  if (bps > 10000) throw new Error(`${label}不能超过 100%`);
  return bps;
}

function yuanString(fen) {
  if (fen === null || fen === undefined) return '';
  const value = BigInt(fen);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function groupedInteger(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function money(fen) {
  if (fen === null || fen === undefined) return '金额待定';
  const raw = yuanString(fen);
  const negative = raw.startsWith('-');
  const [whole, fraction] = raw.replace('-', '').split('.');
  return `${negative ? '−' : ''}¥${groupedInteger(whole)}.${fraction}`;
}

function percent(bps) {
  if (bps === null || bps === undefined) return '';
  const whole = Math.trunc(bps / 100);
  const fraction = String(Math.abs(bps % 100)).padStart(2, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}%`;
}

function requestId() {
  return crypto.randomUUID();
}

function topOverlay() {
  return [...document.querySelectorAll('.dmodal-overlay')].at(-1) || null;
}

function modalShell({ title, hint = '', wide = true, onClose = null }) {
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = el('div', { class: 'dmodal-overlay' });
  const dialog = el('div', {
    class: `dmodal${wide ? ' settlement-modal' : ''}`,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
  });
  const heading = el('h2', { class: 'dmodal-title' }, title);
  const closeButton = el('button', { class: 'btn small', type: 'button' }, '关闭');
  const head = el('div', { class: 'settlement-modal-head' },
    el('div', { class: 'grow' }, heading, hint ? el('p', { class: 'dmodal-hint' }, hint) : null),
    closeButton
  );
  const body = el('div', { class: 'settlement-modal-body' });
  dialog.append(head, body);
  overlay.append(dialog);

  let closed = false;
  let inertedBackground = [];
  const close = (value = null) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
    for (const node of inertedBackground) node.inert = false;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    onClose?.(value);
  };
  const onKeydown = (event) => {
    if (topOverlay() !== overlay) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
    )].filter((node) => node.getClientRects().length && node.getAttribute('aria-hidden') !== 'true');
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!focusable.includes(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  closeButton.addEventListener('click', () => close());
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKeydown);
  document.body.append(overlay);
  inertedBackground = [...document.body.children].filter((node) => node !== overlay && !node.inert);
  for (const node of inertedBackground) node.inert = true;
  requestAnimationFrame(() => dialog.querySelector('input,select,textarea,button')?.focus());
  return { overlay, dialog, body, close };
}

function statusMessage(text, tone = '') {
  return el('div', { class: `settlement-status${tone ? ` ${tone}` : ''}`, role: 'status' }, text);
}

function formulaRevisionLabel(revision) {
  return `${revision.label || '历史分法'} · ${revision.money_view?.human_summary || revision.formula_summary}`;
}

function relationText(direction, counterpart) {
  return direction === 'receivable' ? `${counterpart}应给我` : `我应给${counterpart}`;
}

function moneyEquation(view, { compact = false } = {}) {
  const box = el('div', { class: `settlement-equation${compact ? ' compact' : ''}` });
  for (const row of view?.equation || []) {
    box.append(el('div', { class: `settlement-equation-row is-${row.kind}` },
      el('span', { class: 'settlement-equation-op', 'aria-hidden': 'true' }, row.operator || '·'),
      el('span', { class: 'settlement-equation-label' },
        el('b', {}, row.label),
        row.rule_text ? el('span', { class: 'meta' }, row.rule_text) : null
      ),
      el('span', { class: 'settlement-equation-value num' }, row.value_text)
    ));
  }
  return box;
}

function agreementMoneyCard(agreement, { caseId, onChanged }) {
  const active = agreement.status === 'active';
  const revisions = agreement.revisions || [];
  const latest = agreement.latest_revision || revisions.at(-1);
  const view = latest?.money_view;
  const card = el('article', { class: `money-card is-${agreement.direction}${active ? '' : ' is-retired'}` },
    el('div', { class: 'money-card-head' },
      el('div', { class: 'grow' },
        el('div', { class: 'money-relation' }, relationText(agreement.direction, agreement.counterpart)),
        el('div', { class: 'money-summary' }, view?.human_summary || '分成办法待补充')
      ),
      el('div', { class: 'money-headline' },
        el('b', { class: 'num' }, view?.headline_text || '待定'),
        el('span', { class: `pill ${view?.provisional ? 'warn' : active ? 'ok' : ''}` },
          active ? (view?.provisional ? '暂定' : '有效') : '已停用')
      )
    ),
    view ? moneyEquation(view) : null,
    view?.pending_message ? el('div', { class: 'money-notice' }, view.pending_message) : null,
    el('div', { class: 'money-facts' },
      el('span', {}, '结算时间', el('b', {}, agreement.settlement_term || view?.settlement_term || '待确定')),
      agreement.note ? el('span', {}, '补充说明', el('b', {}, agreement.note)) : null
    )
  );

  if (active) {
    const nextText = view?.provisional
      ? '下一步：扣费方案明确后完善这条分成'
      : (agreement.direction === 'receivable'
        ? '下一步：实际分成基数形成后记应收'
        : '下一步：在具体律师费行确认是否参与');
    card.append(el('div', { class: 'money-next' },
      el('span', { class: 'meta' }, nextText),
      view?.provisional ? el('button', {
        class: 'btn small primary', type: 'button',
        onclick: () => openFormulaEditor({ caseId, agreement, onChanged }),
      }, '完善扣费') : null
    ));
  }

  const advanced = el('details', { class: 'money-advanced' }, el('summary', {}, '历史与高级'));
  advanced.append(el('div', { class: 'settlement-revision-list' }, ...revisions.map((revision) =>
    el('div', { class: 'settlement-revision-row' },
      el('b', {}, `v${revision.revision_no}`),
      el('span', {}, revision.label || '未命名版本'),
      el('span', { class: 'meta' }, revision.money_view?.human_summary || revision.formula_summary),
      el('span', { class: 'meta' }, revision.effective_on || ''),
      revision.change_note ? el('span', { class: 'meta' }, revision.change_note) : null
    )
  )));
  advanced.append(el('div', { class: 'settlement-row-actions' },
    el('button', { class: 'btn small', type: 'button', onclick: () => openAgreementMetadata({ agreement, onChanged }) }, '改对象/时间/备注'),
    active ? el('button', { class: 'btn small', type: 'button', onclick: () => openFormulaEditor({ caseId, agreement, onChanged }) }, '调整分法') : null,
    active ? el('button', { class: 'btn small danger', type: 'button', onclick: async () => {
      if (!confirm(`停用与「${agreement.counterpart}」的分成约定？\n\n已有记录和历史计算仍会保留。`)) return;
      await api(`/share-agreements/${agreement.id}`, { method: 'DELETE' });
      toast('分成约定已停用');
      await onChanged?.();
    } }, '停用约定') : null
  ));
  card.append(advanced);
  return card;
}

function projectedText(revision) {
  if (!revision) return '分成办法待确认';
  return revision.projected_amount_fen === null
    ? '这笔律师费金额确定后计算'
    : `预计 ${money(revision.projected_amount_fen)}（收款时确认）`;
}

function traceRow(step) {
  const title = step.step === 'deduction' ? step.label : '最终分成';
  const rule = step.kind === 'rate'
    ? `${BASIS_LABEL[step.basis] || step.basis} × ${percent(step.rate_bps)}`
    : `固定 ${money(step.fixed_fen)}`;
  const detail = [];
  if (step.basis_fen !== null && step.basis_fen !== undefined) detail.push(`基数 ${money(step.basis_fen)}`);
  detail.push(`计算 ${money(step.calculated_amount_fen)}`);
  detail.push(`采用 ${money(step.applied_amount_fen)}`);
  if (step.step === 'deduction') {
    detail.push(`余额 ${money(step.remaining_before_fen)} → ${money(step.remaining_after_fen)}`);
  }
  return el('div', { class: 'settlement-trace-row' },
    el('span', { class: 'settlement-trace-step' }, title),
    el('span', { class: 'meta' }, rule),
    el('span', { class: 'settlement-trace-values' }, detail.join(' · ')),
    step.clamped ? el('span', { class: 'chip c-amber' }, '已截断') : null
  );
}

function traceBlock(trace = []) {
  const box = el('div', { class: 'settlement-trace' });
  box.append(...trace.map(traceRow));
  if (!trace.length) box.append(el('div', { class: 'section-empty' }, '无计算步骤'));
  return box;
}

function settlementHistory(runs = [], initialSnapshotId = null) {
  const wrap = el('div', { class: 'settlement-history' });
  if (!runs.length) {
    wrap.append(el('div', { class: 'section-empty' }, '还没有收款或修改记录'));
    return wrap;
  }
  const targetSnapshotKey = initialSnapshotId === null ? null : String(initialSnapshotId);
  for (const run of [...runs].reverse()) {
    const snapshots = run.snapshots || [];
    const containsTarget = targetSnapshotKey !== null
      && snapshots.some((snapshot) => String(snapshot.id) === targetSnapshotKey);
    const details = el('details', {
      class: 'settlement-history-item',
      ...(containsTarget ? { open: '' } : {}),
    });
    details.append(el('summary', {},
      el('span', { class: 'pill' }, RUN_LABEL[run.run_kind] || run.run_kind),
      el('b', {}, run.confirmed_at || ''),
      run.reason ? el('span', { class: 'meta' }, run.reason) : null
    ));
    for (const snapshot of snapshots) {
      const isTarget = targetSnapshotKey !== null && String(snapshot.id) === targetSnapshotKey;
      details.append(el('div', {
        class: `settlement-history-snapshot${isTarget ? ' is-target' : ''}`,
        'data-settlement-snapshot-id': snapshot.id,
        ...(isTarget ? {
          tabindex: '-1', role: 'group',
          'aria-label': `当前查看的分成计算：${snapshot.counterpart}`,
        } : {}),
      },
        el('div', { class: 'settlement-plan-main' },
          el('b', {}, snapshot.counterpart),
          el('span', { class: 'chip' }, `v${snapshot.revision_no}`),
          el('span', { class: 'grow meta' }, snapshot.money_view?.human_summary || snapshot.formula_summary || '')
        ),
        el('div', { class: 'settlement-amounts compact' },
          el('span', {}, '按当时分法应分', el('b', { class: 'num' }, money(snapshot.desired_amount_fen))),
          el('span', {}, '此前已记', el('b', { class: 'num' }, money(snapshot.closed_amount_fen))),
          el('span', {}, '这次变化', el('b', { class: 'num' }, money(snapshot.new_amount_fen)))
        ),
        snapshot.trace ? traceBlock(snapshot.trace) : null
      ));
    }
    wrap.append(details);
  }
  return wrap;
}

function formulaPayload({ resultKind, resultBasis, resultValue, deductions }) {
  if (resultKind === 'fixed') {
    return {
      result_kind: 'fixed',
      result_fixed_fen: parseMoneyToFen(resultValue, '固定分成金额'),
      deductions: [],
    };
  }
  return {
    result_kind: 'rate',
    result_basis: resultBasis,
    result_rate_bps: parsePercentToBps(resultValue, '最终分成比例'),
    deductions: deductions.map((deduction, index) => {
      const base = {
        sequence: index + 1,
        label: String(deduction.label || '').trim(),
        kind: deduction.kind,
      };
      if (!base.label) throw new Error(`第 ${index + 1} 个扣费项缺少名称`);
      if (deduction.kind === 'fixed') {
        return {
          ...base,
          fixed_fen: parseMoneyToFen(deduction.value, `${base.label}固定额`, { allowNegative: false }),
        };
      }
      return {
        ...base,
        basis: deduction.basis,
        rate_bps: parsePercentToBps(deduction.value, `${base.label}比例`),
      };
    }),
  };
}

export function openFormulaEditor({ caseId, agreement = null, direction = '', onChanged = null } = {}) {
  return new Promise((resolve) => {
    const isRevision = Boolean(agreement);
    const resolvedDirection = agreement?.direction || direction || 'payable';
    const copy = directionCopy(resolvedDirection);
    const nextRevision = (agreement?.latest_revision?.revision_no || agreement?.revisions?.at(-1)?.revision_no || 0) + 1;
    const modal = modalShell({
      title: isRevision ? `调整「${agreement.counterpart}」的分法` : copy.title,
      hint: isRevision
        ? '保存后会保留原分法和生效记录，已经发生的金额不会被改写。'
        : copy.hint,
      onClose: resolve,
    });
    const form = el('form', { class: 'dmodal-form settlement-formula-editor' });
    const stableGrid = el('div', { class: 'settlement-formula-grid' });

    let directionSelect = null;
    let counterpartInput = null;
    let noteInput = null;
    if (!isRevision) {
      directionSelect = selectOf([
        { value: 'payable', label: '我应付（我分给对方）' },
        { value: 'receivable', label: '我应收（对方分给我）' },
      ], resolvedDirection);
      if (direction) {
        directionSelect.hidden = true;
        directionSelect.setAttribute('aria-hidden', 'true');
        directionSelect.tabIndex = -1;
      }
      counterpartInput = inputOf({ required: '', placeholder: copy.counterpartPlaceholder });
      noteInput = inputOf({ placeholder: copy.notePlaceholder });
      stableGrid.append(
        direction
          ? el('div', { class: 'settlement-readonly' },
            el('span', { class: `chip ${resolvedDirection === 'payable' ? 'c-amber' : 'c-blue'}` }, DIRECTION_LABEL[resolvedDirection]),
            el('span', { class: 'meta' }, resolvedDirection === 'receivable' ? '别人分给我' : '我分给别人'),
            directionSelect
          )
          : field('方向', directionSelect),
        field(copy.counterpart, counterpartInput),
        field('补充说明（可选）', noteInput, 'span-2')
      );
    } else {
      stableGrid.append(
        el('div', { class: 'settlement-readonly' },
          el('span', { class: `chip ${agreement.direction === 'payable' ? 'c-amber' : 'c-blue'}` }, DIRECTION_LABEL[agreement.direction]),
          el('b', {}, agreement.counterpart),
          el('span', { class: 'meta' }, `当前分法：${formulaRevisionLabel(agreement.latest_revision)}`)
        )
      );
    }

    const effectiveInput = inputOf({ type: 'date', value: todayStr(), required: '' });
    const labelInput = inputOf({ value: isRevision ? `第 ${nextRevision} 版` : '初始版本', required: '', placeholder: '如：2026 夏季方案' });
    const changeInput = inputOf({ required: '', placeholder: isRevision ? '说明本次为何变更' : copy.changePlaceholder });
    const resultKind = selectOf([
      { value: 'rate', label: '按比例' },
      { value: 'fixed', label: '固定分成金额' },
    ], 'rate');
    const resultBasis = selectOf([
      { value: 'remaining', label: '扣费后余额' },
      { value: 'gross', label: '原始收费' },
    ], !isRevision && resolvedDirection === 'receivable' ? 'gross' : 'remaining');
    const resultValue = inputOf({ inputmode: 'decimal', required: '', placeholder: '不预设比例' });
    const rateFieldText = resolvedDirection === 'receivable' ? '我的比例（%）' : '对方比例（%）';
    const resultValueLabel = document.createTextNode(rateFieldText);
    const resultValueField = el('label', { class: 'f' }, resultValueLabel, resultValue);
    const basisField = field('最终比例基数', resultBasis);

    const currentFormula = agreement?.latest_revision?.formula;
    if (currentFormula?.result_kind) {
      resultKind.value = currentFormula.result_kind;
      if (currentFormula.result_basis) resultBasis.value = currentFormula.result_basis;
      resultValue.value = currentFormula.result_kind === 'fixed'
        ? yuanString(currentFormula.result_fixed_fen)
        : String(currentFormula.result_rate_bps / 100);
    }

    const settlementTermInput = inputOf({
      value: agreement?.settlement_term || (resolvedDirection === 'receivable' ? '' : '收到律师费当月'),
      required: '',
      placeholder: resolvedDirection === 'receivable'
        ? '如：对方收到律师费当月 / 2026 年 8 月前'
        : '如：收到律师费当月 / 次月 10 日前',
    });
    const provisional = el('input', { type: 'checkbox' });
    provisional.checked = Boolean(agreement?.latest_revision?.is_provisional);
    const pendingDeductions = inputOf({
      value: agreement?.latest_revision?.pending_deductions || '税费、律所费用',
      placeholder: '如：税费、律所费用',
    });
    const formulaGrid = el('div', { class: 'settlement-formula-grid' },
      field('怎么分', resultKind),
      resultValueField,
      field('什么时候结算', settlementTermInput, 'span-2'),
      el('label', { class: 'f span-2 settlement-check' }, provisional, el('span', {}, '扣税或律所费用还没定，先按暂定比例记录')),
      field('还有哪些扣费待确定', pendingDeductions, 'span-2')
    );

    const auditDetails = el('details', { class: 'money-advanced settlement-step' },
      el('summary', {}, '历史与高级'),
      el('div', { class: 'settlement-formula-grid' },
        field('生效日', effectiveInput),
        field('版本标签', labelInput),
        basisField,
        isRevision ? field('为什么调整', changeInput, 'span-2') : null
      )
    );

    const deductionList = el('div', { class: 'settlement-deductions' });
    const addDeduction = el('button', { class: 'btn small', type: 'button' }, '添加扣费项');
    const deductionSection = el('section', { class: 'settlement-step' },
      el('div', { class: 'settlement-section-head' },
        el('div', {}, el('b', {}, '先扣什么'), el('div', { class: 'meta' }, '例如律所费用、税费或其他约定支出；没有就留空。')),
        addDeduction
      ),
      deductionList
    );
    const deductions = (currentFormula?.deductions || []).map((step) => ({
      label: step.label,
      kind: step.kind,
      basis: step.basis || 'remaining',
      value: step.kind === 'fixed' ? yuanString(step.fixed_fen) : String(step.rate_bps / 100),
    }));

    function renderDeductions() {
      deductionList.replaceChildren();
      if (!deductions.length) {
        deductionList.append(el('div', { class: 'section-empty' }, '没有扣费项；比例直接按本笔律师费计算'));
        return;
      }
      deductions.forEach((deduction, index) => {
        const labelInput = inputOf({ value: deduction.label, placeholder: '扣费名称' });
        const kindSelect = selectOf([
          { value: 'fixed', label: '固定额' },
          { value: 'rate', label: '比例' },
        ], deduction.kind);
        const basisSelect = selectOf([
          { value: 'gross', label: '按本笔律师费计算' },
          { value: 'remaining', label: '按前面扣完后的金额计算' },
        ], deduction.basis || 'remaining');
        const valueInput = inputOf({ value: deduction.value, inputmode: 'decimal', placeholder: deduction.kind === 'rate' ? '比例 %' : '金额 元' });
        labelInput.addEventListener('input', () => { deduction.label = labelInput.value; });
        valueInput.addEventListener('input', () => { deduction.value = valueInput.value; });
        basisSelect.addEventListener('change', () => { deduction.basis = basisSelect.value; });
        kindSelect.addEventListener('change', () => {
          deduction.kind = kindSelect.value;
          deduction.value = '';
          renderDeductions();
        });
        const actions = el('span', { class: 'settlement-deduction-actions' },
          el('button', { class: 'btn small', type: 'button', disabled: index === 0 ? '' : null, onclick: () => {
            if (index === 0) return;
            [deductions[index - 1], deductions[index]] = [deductions[index], deductions[index - 1]];
            renderDeductions();
          } }, '上移'),
          el('button', { class: 'btn small', type: 'button', disabled: index === deductions.length - 1 ? '' : null, onclick: () => {
            if (index === deductions.length - 1) return;
            [deductions[index + 1], deductions[index]] = [deductions[index], deductions[index + 1]];
            renderDeductions();
          } }, '下移'),
          el('button', { class: 'btn small danger', type: 'button', onclick: () => {
            deductions.splice(index, 1);
            renderDeductions();
          } }, '删')
        );
        const advancedBasis = el('details', { class: 'money-advanced settlement-deduction-basis-picker' },
          el('summary', {}, '高级：这项按什么计算'),
          basisSelect
        );
        deductionList.append(el('div', { class: 'settlement-deduction-row' },
          el('span', { class: 'pill' }, String(index + 1)),
          labelInput,
          kindSelect,
          deduction.kind === 'rate' ? advancedBasis : el('span', { class: 'meta settlement-deduction-basis' }, '直接扣减'),
          valueInput,
          actions
        ));
      });
    }

    addDeduction.addEventListener('click', () => {
      deductions.push({ label: '', kind: 'fixed', basis: deductions.length ? 'remaining' : 'gross', value: '' });
      if (resultKind.value === 'rate' && !provisional.checked) resultBasis.value = 'remaining';
      renderDeductions();
    });

    function syncResultKind() {
      const fixed = resultKind.value === 'fixed';
      basisField.hidden = fixed;
      deductionSection.hidden = fixed;
      provisional.closest('label').hidden = fixed;
      pendingDeductions.closest('label').hidden = fixed || !provisional.checked;
      if (!fixed && provisional.checked) {
        resultBasis.value = 'gross';
        basisField.hidden = true;
      } else if (!fixed && !isRevision) {
        resultBasis.value = deductions.length ? 'remaining' : 'gross';
      }
      resultValueLabel.data = fixed ? '固定分成金额（元）' : rateFieldText;
      resultValue.placeholder = fixed ? '0.00' : '不预设比例';
    }
    resultKind.addEventListener('change', syncResultKind);
    provisional.addEventListener('change', syncResultKind);
    syncResultKind();
    renderDeductions();

    const status = statusMessage(isRevision
      ? '保存后会保留原分法；已经发生的金额不会被覆盖。'
      : copy.status);
    const submit = el('button', { class: 'btn primary', type: 'submit' }, isRevision ? '保存新分法' : copy.submit);
    const actions = el('div', { class: 'dmodal-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, '取消'),
      submit
    );
    form.append(stableGrid, formulaGrid, deductionSection, auditDetails, status, actions);
    modal.body.append(form);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      status.className = 'settlement-status';
      status.textContent = '正在保存分成办法…';
      try {
        const payload = {
          effective_on: effectiveInput.value,
          label: labelInput.value.trim(),
          change_note: isRevision ? changeInput.value.trim() : '首次记录分成约定',
          rounding_mode: 'toward_zero',
          is_provisional: provisional.checked,
          pending_deductions: provisional.checked ? pendingDeductions.value.trim() : '',
          ...formulaPayload({
            resultKind: resultKind.value,
            resultBasis: resultBasis.value,
            resultValue: resultValue.value,
            deductions,
          }),
        };
        if (!payload.label) throw new Error('版本标签不能为空');
        if (isRevision && !payload.change_note) throw new Error('请说明为什么调整');
        let result;
        if (isRevision) {
          payload.settlement_term = settlementTermInput.value.trim();
          if (!payload.settlement_term) throw new Error('请填写什么时候结算');
          result = await api(`/share-agreements/${agreement.id}/revisions`, { body: payload });
          toast('新的分成办法已保存 ✓');
        } else {
          payload.direction = directionSelect.value;
          payload.counterpart = counterpartInput.value.trim();
          payload.note = noteInput.value.trim();
          payload.settlement_term = settlementTermInput.value.trim();
          if (!payload.counterpart) throw new Error('合作对象不能为空');
          if (!payload.settlement_term) throw new Error('请填写什么时候结算');
          result = await api(`/cases/${caseId}/share-agreements`, { body: payload });
          toast(copy.success);
        }
        await onChanged?.(result);
        modal.close(result);
      } catch (error) {
        status.className = 'settlement-status warn';
        status.textContent = error.message;
      } finally {
        submit.disabled = false;
      }
    });
  });
}

function openAgreementMetadata({ agreement, onChanged }) {
  return new Promise((resolve) => {
    const modal = modalShell({ title: `修改「${agreement.counterpart}」`, hint: '这里只改合作对象、结算时间和补充说明；分成算法请用“调整分法”。', wide: false, onClose: resolve });
    const counterpart = inputOf({ value: agreement.counterpart, required: '' });
    const settlementTerm = inputOf({ value: agreement.settlement_term || '待确定', required: '' });
    const note = inputOf({ value: agreement.note || '' });
    const status = statusMessage('这不会改动已经发生的分成金额或历史记录。');
    const submit = el('button', { class: 'btn primary', type: 'submit' }, '保存');
    const form = el('form', { class: 'dmodal-form' },
      field('合作对象', counterpart),
      field('什么时候结算', settlementTerm),
      field('备注', note),
      status,
      el('div', { class: 'dmodal-actions' },
        el('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, '取消'),
        submit
      )
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        const result = await api(`/share-agreements/${agreement.id}`, {
          method: 'PATCH',
          body: {
            counterpart: counterpart.value.trim(),
            settlement_term: settlementTerm.value.trim(),
            note: note.value.trim(),
          },
        });
        toast('约定信息已更新 ✓');
        await onChanged?.(result);
        modal.close(result);
      } catch (error) {
        status.className = 'settlement-status warn';
        status.textContent = error.message;
      } finally {
        submit.disabled = false;
      }
    });
    modal.body.append(form);
  });
}

export function renderAgreementManager({ agreements = [], target, caseId, onChanged = null }) {
  const receivable = agreements.filter((agreement) => agreement.direction === 'receivable');
  const payable = agreements.filter((agreement) => agreement.direction === 'payable');
  const group = (direction, rows) => el('section', { class: `settlement-agreement-group is-${direction}` },
    el('div', { class: 'settlement-agreement-group-head' },
      el('span', { class: `chip ${direction === 'payable' ? 'c-amber' : 'c-blue'}` }, DIRECTION_LABEL[direction]),
      el('b', {}, direction === 'receivable' ? '别人应给我的分成' : '我应给别人的分成'),
      el('span', { class: 'meta' }, `${rows.length} 条约定`)
    ),
    rows.length
      ? rows.map((agreement) => agreementMoneyCard(agreement, { caseId, onChanged }))
      : el('div', { class: 'section-empty' }, direction === 'receivable'
        ? '尚未登记别人应给我的分成约定'
        : '尚未登记我应给别人的分成约定')
  );
  target.replaceChildren(group('receivable', receivable), group('payable', payable));
}

function planDecisionRow(agreement, { fee, onSaved }) {
  const plan = agreement.plan;
  const decision = selectOf([
    { value: '', label: '请选择…' },
    { value: 'assigned', label: '这笔律师费参与分成' },
    { value: 'not_applicable', label: '这笔律师费不参与分成' },
  ], plan?.status || '');
  const note = inputOf({ value: plan?.decision_note || '', placeholder: '可选：补充说明这笔钱为什么参与或不参与' });
  const choiceBox = el('div', { class: 'settlement-plan-choice' });
    const currentRevision = plan?.revision || null;
    const latestRevision = agreement.latest_revision;
    const issue = agreement.unresolved;
    const latestProvisional = latestRevision?.is_provisional === 1;
  let initialRevision = null;
  let revisionChoice = null;

  function renderChoice() {
    choiceBox.replaceChildren();
    if (decision.value !== 'assigned') return;
    if (latestProvisional && !plan) {
      choiceBox.append(el('div', { class: 'settlement-warning' }, '这条分成的扣费方案还没定，先回案件资金区完善后再使用。'));
      return;
    }
    if (plan?.status === 'assigned') {
      if (!currentRevision) {
        revisionChoice = selectOf([
          { value: '', label: '当前分法不可用，请采用最新分法…' },
          ...(latestRevision ? [{ value: 'adopt_latest', label: `采用最新分法（v${latestRevision.revision_no}）` }] : []),
        ]);
        choiceBox.append(field('采用哪套分法', revisionChoice),
          el('div', { class: 'settlement-warning' }, '当前保存的分法不可用；重新选择后才能结算。'));
      } else if (agreement.has_newer_revision) {
        const needsDecision = issue?.code === 'revision_decision_required';
        const savedChoice = plan.revision_choice === 'keep_current' ? 'keep_current' : '';
        revisionChoice = selectOf([
          { value: '', label: '选择继续原分法或改用新分法…' },
          { value: 'keep_current', label: `继续原分法（v${currentRevision.revision_no}）` },
          { value: 'adopt_latest', label: `改用最新分法（v${latestRevision.revision_no}）` },
        ], needsDecision ? '' : savedChoice);
        choiceBox.append(field('分法有更新', revisionChoice),
          el('div', { class: needsDecision ? 'settlement-warning' : 'meta' }, needsDecision
            ? '分成办法已经更新。系统不会偷偷替换，请明确选择。'
            : `目前继续按原分法；如需切换，可改用最新分法。`));
      } else {
        choiceBox.append(el('div', { class: 'settlement-readonly' },
          el('span', { class: 'chip' }, '按已确认分法'),
          el('span', { class: 'meta' }, currentRevision.money_view?.human_summary || currentRevision.formula_summary)
        ));
      }
      return;
    }
    initialRevision = selectOf([
      { value: '', label: '选择一套历史分法…' },
      ...(agreement.revisions || []).map((revision) => ({ value: String(revision.id), label: formulaRevisionLabel(revision) })),
    ], latestRevision ? String(latestRevision.id) : '');
    if ((agreement.revisions || []).length <= 1 && latestRevision) {
      choiceBox.append(el('div', { class: 'settlement-readonly' },
        el('span', { class: 'meta' }, '按当前约定'),
        el('b', {}, latestRevision.money_view?.human_summary || latestRevision.formula_summary)
      ));
    } else {
      choiceBox.append(el('details', { class: 'money-advanced' },
        el('summary', {}, '高级：选择历史分法'),
        field('采用哪套分法', initialRevision)
      ));
    }
  }
  decision.addEventListener('change', renderChoice);
  renderChoice();

  const projection = plan?.status === 'assigned'
    ? projectedText(currentRevision)
    : '确认参与后显示预计金额';
  const status = statusMessage(issue?.message || projection, issue ? 'warn' : '');
  const save = el('button', { class: 'btn small primary', type: 'button' }, '保存决定');
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      if (!decision.value) throw new Error('请选择适用或不适用');
      if (decision.value === 'assigned' && latestProvisional && !plan) {
        throw new Error('这条分成的扣费方案还没定，暂不能用于具体律师费');
      }
      let formulaRevisionId = null;
      let choice = 'not_applicable';
      if (decision.value === 'assigned') {
        if (plan?.status === 'assigned') {
          if (!currentRevision) {
            choice = revisionChoice.value;
            if (choice !== 'adopt_latest' || !latestRevision) throw new Error('请选择一个可用的最新分法');
            formulaRevisionId = latestRevision.id;
          } else if (agreement.has_newer_revision) {
            choice = revisionChoice.value;
            if (!choice) throw new Error('请选择继续原分法或改用新分法');
            formulaRevisionId = choice === 'keep_current' ? currentRevision.id : latestRevision.id;
          } else {
            choice = 'keep_current';
            formulaRevisionId = currentRevision.id;
          }
        } else {
          choice = 'initial';
          formulaRevisionId = latestRevision && (agreement.revisions || []).length <= 1
            ? latestRevision.id
            : Number(initialRevision.value);
          if (!formulaRevisionId) throw new Error('请选择分成办法');
        }
      }
      await api(`/fees/${fee.id}/share-plans`, {
        method: 'PUT',
        body: {
          plans: [{
            agreement_id: agreement.id,
            status: decision.value,
            formula_revision_id: formulaRevisionId,
            revision_choice: choice,
            decision_note: note.value.trim() || (decision.value === 'assigned' ? '本笔律师费参与分成' : '本笔律师费不参与分成'),
            version: plan?.version ?? 0,
          }],
        },
      });
      toast('这笔律师费的分成办法已保存 ✓');
      await onSaved();
    } catch (error) {
      status.className = 'settlement-status warn';
      status.textContent = error.message;
    } finally {
      save.disabled = false;
    }
  });

  const displayedRevision = currentRevision || latestRevision;
  return el('div', { class: `settlement-plan-row${issue ? ' is-unresolved' : ''}` },
    el('div', { class: 'settlement-plan-main' },
      el('span', { class: 'chip c-amber' }, `我应给${agreement.counterpart}`),
      el('span', { class: 'grow meta' }, displayedRevision?.money_view?.human_summary || displayedRevision?.formula_summary || '')
    ),
    el('div', { class: 'settlement-plan-fields' },
      field('这笔律师费', decision),
      field('补充说明（可选）', note, 'grow')
    ),
    choiceBox,
    status,
    el('div', { class: 'settlement-row-actions' }, save)
  );
}

function requestControls({ bundle, runKind }) {
  const fee = bundle.fee;
  const runs = bundle.settlement_runs || [];
  const source = runs.at(-1) || null;
  const form = el('div', { class: 'settlement-request-form' });
  let amountInput = null;
  let paidOnInput = null;
  let reasonInput = null;

  if (runKind !== 'reversal') {
    amountInput = inputOf({ value: yuanString(fee.amount_fen), inputmode: 'decimal', placeholder: '金额尚未确定可先留空；确认收款前需补齐' });
    paidOnInput = inputOf({ type: 'date', value: fee.paid_on || todayStr(), required: '' });
    form.append(
      field('本次收费金额（元）', amountInput),
      field('实际到账日', paidOnInput)
    );
  }
  if (runKind !== 'receipt') {
    reasonInput = inputOf({ placeholder: runKind === 'reversal' ? '说明为何撤销这次收款' : '说明本次更正内容', required: '' });
    form.append(field('更正 / 撤销原因', reasonInput, 'span-2'));
  }
  return { form, amountInput, paidOnInput, reasonInput, source };
}

function publicPreview(preview) {
  const wrap = el('div', { class: 'settlement-preview' });
  wrap.append(el('div', { class: 'settlement-amounts' },
    el('span', {}, '按当前分法应分', el('b', { class: 'num' }, money(preview.totals.desired_amount_fen))),
    el('span', {}, '此前已记', el('b', { class: 'num' }, money(preview.totals.closed_amount_fen))),
    el('span', {}, '这次新增', el('b', { class: 'num' }, money(preview.totals.new_amount_fen)))
  ));
  if (!preview.settlements.length) {
    wrap.append(el('div', { class: 'settlement-warning' }, '这笔律师费没有需要分给别人的约定。确认后只更新收款状态，不会新增待分记录。'));
    return wrap;
  }
  for (const settlement of preview.settlements) {
    wrap.append(el('div', { class: 'settlement-preview-card' },
      el('div', { class: 'settlement-plan-main' },
        el('b', {}, `我应给${settlement.counterpart}`),
        el('span', { class: 'grow meta' }, settlement.money_view?.human_summary || settlement.formula_summary),
        el('b', { class: 'num' }, money(settlement.new_amount_fen))
      ),
      settlement.money_view ? moneyEquation(settlement.money_view) : traceBlock(settlement.trace),
      el('details', { class: 'money-advanced' },
        el('summary', {}, '逐步取整与高级核对'),
        traceBlock(settlement.trace)
      )
    ));
  }
  if (preview.totals.new_amount_fen === 0) {
    wrap.append(el('div', { class: 'settlement-warning' }, '本次金额没有变化；确认后只保留核对记录，不会新增 0 元待分记录。'));
  }
  return wrap;
}

function errorText(error) {
  if (error.code === 'settlement_preview_stale') return '计算结果已过期：律师费、分法或历史记录有变化。请重新算一次。';
  if (error.code === 'settlement_plan_unresolved') return '还有分成没确认。请先逐条选择这笔律师费是否参与。';
  if (error.code === 'provisional_formula_not_assignable') return '这条分成的扣费方案还没定，先在案件资金区点“完善扣费”。';
  if (error.code === 'assignment_version_conflict') return '分成办法已在别处更新，请刷新后重试。';
  if (error.code === 'settlement_source_not_head') return '这笔收款已有后续修改，请刷新后再操作。';
  return error.message;
}

export async function openFeeSettlement({ fee, onChanged = null, runKind = null, initialSnapshotId = null } = {}) {
  const modal = modalShell({
    title: runKind
      ? `${runKind === 'receipt' ? '确认收到律师费' : runKind === 'correction' ? '修改这笔结算' : '撤销这次收款'} · ${fee.label}`
      : `这笔律师费怎么分 · ${fee.label}`,
    hint: '确认谁参与、怎么分和实际到账日；金额始终由系统按保存的规则计算。',
  });
  modal.body.append(statusMessage('正在读取这笔律师费和分成约定…'));

  let bundle = null;
  let activePreview = null;
  const initialSnapshotKey = initialSnapshotId === null || initialSnapshotId === undefined || initialSnapshotId === ''
    ? null
    : String(initialSnapshotId);
  let initialSnapshotFocusPending = initialSnapshotKey !== null;

  async function reload({ refreshHost = false } = {}) {
    bundle = await api(`/fees/${fee.id}/share-plans`);
    render();
    if (refreshHost) await onChanged?.();
  }

  function renderPlans(section) {
    const list = el('div', { class: 'settlement-plan-list' });
    const onSaved = () => reload({ refreshHost: true });
    for (const agreement of bundle.agreements) {
      list.append(planDecisionRow(agreement, { fee: bundle.fee, onSaved }));
    }
    if (!bundle.agreements.length) {
      list.append(el('div', { class: 'section-empty' }, '本案还没有“我分给别人”的约定；可以先新增，也可以直接确认收款且不产生分成。'));
    }
    const add = el('button', { class: 'btn small', type: 'button', onclick: async () => {
      await openFormulaEditor({
        caseId: bundle.fee.case_id,
        direction: 'payable',
        onChanged: async () => reload({ refreshHost: true }),
      });
    } }, '新增“我分给别人”约定');
    section.append(
      el('div', { class: 'settlement-section-head' },
        el('div', {}, el('b', {}, '谁参与这笔分成'), el('div', { class: 'meta' }, '逐条确认这笔律师费是否按该约定分。')),
        add
      ),
      list
    );
  }

  function renderSettlement(section) {
    const controls = requestControls({ bundle, runKind });
    const status = statusMessage('修改输入后请重新预览。');
    const previewBox = el('div', { class: 'settlement-preview-box' });
    const previewButton = el('button', { class: 'btn primary', type: 'button' }, '算一算');
    const unresolved = bundle.unresolved_active_payable_agreements || [];
    const sourceRequired = runKind !== 'receipt';

    if (sourceRequired && !controls.source) {
      section.append(el('div', { class: 'settlement-warning' }, '找不到可修改的上一笔收款记录，请关闭并刷新页面。'));
      return;
    }
    if (runKind !== 'reversal' && unresolved.length) {
      status.className = 'settlement-status warn';
      status.textContent = `还有 ${unresolved.length} 条分成没确认，先决定这笔律师费是否参与。`;
      previewButton.disabled = true;
    }

    function invalidate() {
      activePreview = null;
      previewBox.replaceChildren();
      status.className = 'settlement-status';
      status.textContent = '输入已变化，请重新算一算。';
    }
    controls.form.addEventListener('input', invalidate);
    controls.form.addEventListener('change', invalidate);

    previewButton.addEventListener('click', async () => {
      previewButton.disabled = true;
      status.className = 'settlement-status';
      status.textContent = '正在按当前分法计算…';
      previewBox.replaceChildren();
      try {
        const body = {
          run_kind: runKind,
          request_id: requestId(),
          fee_version: bundle.fee.version,
        };
        if (runKind !== 'receipt') {
          body.source_run_id = controls.source.id;
          body.reason = controls.reasonInput.value.trim();
          if (!body.reason) throw new Error('请填写更正 / 撤销原因');
        }
        if (runKind !== 'reversal') {
          body.base_amount_fen = controls.amountInput.value.trim()
            ? parseMoneyToFen(controls.amountInput.value, '收费金额')
            : null;
          body.paid_on = controls.paidOnInput.value;
          if (!body.paid_on) throw new Error('请选择实际到账日');
        }
        const preview = await api(`/fees/${fee.id}/settlements/preview`, { body });
        const confirmBody = Object.freeze({
          ...preview.request,
          fee_version: preview.fee_version,
          preview_hash: preview.preview_hash,
        });
        activePreview = { preview, confirmBody };
        const confirmButton = el('button', { class: 'btn primary', type: 'button' },
          runKind === 'receipt' ? '确认收款并记账' : runKind === 'correction' ? '确认修改' : '确认撤销');
        confirmButton.addEventListener('click', async () => {
          if (!activePreview || activePreview.confirmBody !== confirmBody) return;
          confirmButton.disabled = true;
          status.className = 'settlement-status';
          status.textContent = '正在事务内重读、重算并写入…';
          try {
            const result = await api(`/fees/${fee.id}/settlements/confirm`, { body: confirmBody });
            toast(result.idempotent ? '该结算已确认（幂等返回）' : `${RUN_LABEL[runKind]}已确认 ✓`);
            await onChanged?.();
            modal.close(result);
          } catch (error) {
            activePreview = null;
            previewBox.replaceChildren();
            status.className = 'settlement-status warn';
            status.textContent = errorText(error);
            if (['settlement_preview_stale', 'assignment_version_conflict', 'settlement_source_not_head'].includes(error.code)) {
              await reload({ refreshHost: true });
            }
          } finally {
            confirmButton.disabled = false;
          }
        });
        previewBox.append(
          publicPreview(preview),
          el('div', { class: 'settlement-confirm-bar' },
            el('span', { class: 'meta' }, '确认时系统会再次核对金额和分法，避免页面停留期间数据变化。'),
            confirmButton
          ),
          el('details', { class: 'money-advanced' },
            el('summary', {}, '技术校验信息'),
            el('div', { class: 'meta' }, `款项版本 ${preview.fee_version} · 校验 ${preview.preview_hash.slice(0, 12)}…`)
          )
        );
        status.textContent = '计算完成，请核对后确认。';
      } catch (error) {
        activePreview = null;
        status.className = 'settlement-status warn';
        status.textContent = errorText(error);
      } finally {
        previewButton.disabled = Boolean(runKind !== 'reversal' && bundle.unresolved_active_payable_agreements.length);
      }
    });

    section.append(
      el('div', { class: 'settlement-section-head' },
        el('div', {}, el('b', {}, runKind === 'receipt' ? '收到律师费并结算' : runKind === 'correction' ? '修改这笔结算' : '撤销这次收款'),
          el('div', { class: 'meta' }, runKind === 'reversal'
            ? '撤回这次收款及其尚未完成的分成；已减免金额不恢复。'
            : '先算清本次应分金额，再由你确认收款或修改。'))
      ),
      controls.form,
      status,
      el('div', { class: 'settlement-row-actions' }, previewButton),
      previewBox
    );
  }

  function render() {
    modal.body.replaceChildren();
    const feeSummary = el('section', { class: 'settlement-step' },
      el('div', { class: 'settlement-plan-main' },
        el('span', { class: `pill ${bundle.fee.status === 'paid' ? 'ok' : 'warn'}` }, bundle.fee.status === 'paid' ? '已收' : '待收'),
        el('b', {}, bundle.fee.label),
        el('span', { class: 'num' }, money(bundle.fee.amount_fen)),
        el('span', { class: 'grow meta' }, bundle.fee.paid_on || bundle.fee.due_on || '日期待定'),
        bundle.unresolved_active_payable_agreements.length
          ? el('span', { class: 'chip c-amber' }, `${bundle.unresolved_active_payable_agreements.length} 条分成待确认`)
          : el('span', { class: 'chip c-green' }, '分成办法已确认')
      )
    );
    const planSection = el('section', { class: 'settlement-step' });
    renderPlans(planSection);
    modal.body.append(feeSummary, planSection);
    if (runKind) {
      const settlementSection = el('section', { class: 'settlement-step' });
      renderSettlement(settlementSection);
      modal.body.append(settlementSection);
    }
    const initialSnapshotExists = initialSnapshotKey !== null
      && bundle.settlement_runs.some((run) => (run.snapshots || [])
        .some((snapshot) => String(snapshot.id) === initialSnapshotKey));
    const historyDetails = el('details', {
      class: 'money-advanced',
      ...(initialSnapshotExists ? { open: '' } : {}),
    },
      el('summary', {}, '历史与高级'),
      el('div', { class: 'meta' }, '保留每次收款、修改、撤销时的分法和计算结果。'),
      settlementHistory(bundle.settlement_runs, initialSnapshotExists ? initialSnapshotKey : null)
    );
    modal.body.append(el('section', { class: 'settlement-step' }, historyDetails));

    if (initialSnapshotExists && initialSnapshotFocusPending) {
      initialSnapshotFocusPending = false;
      requestAnimationFrame(() => {
        const target = [...modal.body.querySelectorAll('[data-settlement-snapshot-id]')]
          .find((node) => node.dataset.settlementSnapshotId === initialSnapshotKey);
        const runDetails = target?.closest('.settlement-history-item');
        if (!target || !runDetails) return;
        runDetails.open = true;
        target.focus({ preventScroll: true });
        const dialogRect = modal.dialog.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        modal.dialog.scrollTop += targetRect.top - dialogRect.top
          - Math.max(0, (modal.dialog.clientHeight - targetRect.height) / 2);
      });
    }
  }

  try {
    await reload();
  } catch (error) {
    modal.body.replaceChildren(statusMessage(errorText(error), 'warn'));
  }
}

function planChips(fee, { includeUnresolved = true } = {}) {
  const chips = [];
  const unresolved = fee.unresolved_active_payable_agreements || [];
  if (includeUnresolved && unresolved.length) {
    chips.push(el('span', { class: 'chip c-amber' }, `${unresolved.length} 条分成待确认`));
  }
  for (const agreement of fee.share_plans || []) {
    if (agreement.plan?.status !== 'assigned') continue;
    const revision = agreement.plan.revision;
    const projection = agreement.plan.projected_amount_fen === null
      ? '待金额'
      : `预计 ${money(agreement.plan.projected_amount_fen)}`;
    chips.push(el('span', {
      class: 'chip',
      title: `${agreement.counterpart} · ${revision?.money_view?.human_summary || agreement.plan.formula_summary || ''}`,
    }, `我应给${agreement.counterpart} · ${projection}`));
  }
  return chips;
}

export function feeSettlementActions({ fee, onChanged, extraActions = [] }) {
  if (!['unpaid', 'paid', 'waived'].includes(fee.status)) return null;
  // 已减免款不参与当前收款，未逐款确认的约定要等恢复待收后才重新成为待办。
  const chips = planChips(fee, { includeUnresolved: fee.status !== 'waived' });
  if (fee.status === 'waived') {
    if (fee.settlement_context?.assignment) {
      chips.push(el('span', { class: 'chip c-green' }, '分成办法已保留'));
    }
    if (!chips.length && !extraActions.length) return null;
    return el('span', { class: 'tl-actions settlement-actions' },
      chips.length ? el('span', { class: 'settlement-plan-chips' }, ...chips) : null,
      extraActions.length ? el('span', { class: 'settlement-action-buttons' }, ...extraActions) : null
    );
  }
  const runs = fee.settlement_runs || [];
  const head = runs.at(-1) || null;
  const unresolvedCount = (fee.unresolved_active_payable_agreements || []).length;
  const primaryLabel = (fallback) => unresolvedCount
    ? `先确认分成办法（${unresolvedCount} 条）`
    : fallback;
  const buttons = [
    el('button', { class: 'btn small', type: 'button', onclick: () => openFeeSettlement({ fee, onChanged }) }, '这笔怎么分'),
  ];
  if (!head) {
    buttons.push(el('button', {
      class: 'btn small primary', type: 'button',
      onclick: () => openFeeSettlement({ fee, onChanged, runKind: 'receipt' }),
    }, primaryLabel(fee.status === 'paid' ? '补记分成' : '确认收到律师费')));
  } else if (head.target_status === 'paid') {
    buttons.push(
      el('button', { class: 'btn small primary', type: 'button', onclick: () => openFeeSettlement({ fee, onChanged, runKind: 'correction' }) }, primaryLabel('修改这笔结算')),
      el('button', { class: 'btn small danger', type: 'button', onclick: () => openFeeSettlement({ fee, onChanged, runKind: 'reversal' }) }, '撤销这次收款')
    );
  } else {
    buttons.push(el('button', {
      class: 'btn small primary', type: 'button',
      onclick: () => openFeeSettlement({ fee, onChanged, runKind: 'correction' }),
    }, primaryLabel('重新确认收款')));
  }
  return el('span', { class: 'tl-actions settlement-actions' },
    chips.length ? el('span', { class: 'settlement-plan-chips' }, ...chips) : null,
    el('span', { class: 'settlement-action-buttons' }, ...buttons, ...extraActions)
  );
}
