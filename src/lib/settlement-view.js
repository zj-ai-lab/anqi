import { fenToYuanString, normalizeSettlementFormula } from './settlement.js';

function percentText(bps) {
  const whole = Math.trunc(bps / 100);
  const fraction = String(Math.abs(bps % 100)).padStart(2, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}%`;
}

function moneyText(fen) {
  if (fen === null || fen === undefined) return '金额待定';
  const raw = fenToYuanString(fen);
  const negative = raw.startsWith('-');
  const [whole, fraction] = raw.replace('-', '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}${grouped}.${fraction} 元`;
}

export function formatSettlementMoneyFen(fen) {
  return moneyText(fen);
}

export function formatSettlementPercentBps(bps) {
  return percentText(bps);
}

function deductionRule(step) {
  return step.kind === 'fixed'
    ? `固定 ${moneyText(step.fixed_fen)}`
    : `${percentText(step.rate_bps)}`;
}

function humanSummary(formula, { provisional = false, pendingDeductions = '' } = {}) {
  if (formula.result_kind === 'fixed') return `固定分成 ${moneyText(formula.result_fixed_fen)}`;
  const rate = percentText(formula.result_rate_bps);
  if (provisional) {
    return `${pendingDeductions || '前置扣费'}待确定，暂按本笔律师费的 ${rate} 记录`;
  }
  if (!formula.deductions.length) return `不先扣费用，按本笔律师费的 ${rate}`;
  const deductions = formula.deductions.map((step) => (
    step.kind === 'fixed'
      ? `先扣${step.label} ${moneyText(step.fixed_fen)}`
      : `先扣${step.label} ${percentText(step.rate_bps)}`
  ));
  const basis = formula.result_basis === 'remaining' ? '扣费后金额' : '本笔律师费';
  return `${deductions.join('，')}，再按${basis}的 ${rate}`;
}

/**
 * 把确定性公式/轨迹投影成律师可读的资金卡 view model。
 * 本函数不做金额计算；所有 amount_fen 都来自调用方给出的后端计算结果或 trace。
 */
export function createSettlementMoneyView({
  direction = 'payable',
  counterpart = '',
  formula: definition,
  trace = null,
  baseFen = null,
  amountFen = null,
  provisional = false,
  pendingDeductions = '',
  settlementTerm = '',
} = {}) {
  const formula = normalizeSettlementFormula(definition);
  const resultLabel = direction === 'receivable' ? '我应收' : '我应付';
  const rateLabel = direction === 'receivable' ? '我的比例' : '对方比例';
  const relationLabel = direction === 'receivable'
    ? `${counterpart || '对方'}应给我`
    : `我应给${counterpart || '对方'}`;
  const traceRows = Array.isArray(trace) ? trace : [];
  const equation = [];

  if (formula.result_kind === 'fixed') {
    equation.push({
      kind: 'result', operator: '=', label: resultLabel,
      amount_fen: formula.result_fixed_fen, value_text: moneyText(formula.result_fixed_fen),
    });
  } else {
    equation.push({
      kind: 'base', operator: '', label: '本笔律师费',
      amount_fen: baseFen,
      value_text: baseFen === null
        ? (direction === 'receivable' ? '待关联实际分成基数' : '按参与分成的款项计算')
        : moneyText(baseFen),
    });
    for (const deduction of formula.deductions) {
      const traced = traceRows.find((step) => step.step === 'deduction' && step.sequence === deduction.sequence);
      equation.push({
        kind: 'deduction', operator: '−', label: deduction.label,
        rule_text: deductionRule(deduction),
        amount_fen: traced?.applied_amount_fen ?? null,
        value_text: traced ? moneyText(traced.applied_amount_fen) : deductionRule(deduction),
      });
    }
    if (provisional) {
      equation.push({
        kind: 'pending', operator: '−', label: pendingDeductions || '其余前置扣费',
        amount_fen: null, value_text: '方案待确定',
      });
    }
    if (formula.deductions.length && !provisional) {
      const last = [...traceRows].reverse().find((step) => step.step === 'deduction');
      equation.push({
        kind: 'subtotal', operator: '=', label: '扣费后金额',
        amount_fen: last?.remaining_after_fen ?? null,
        value_text: last ? moneyText(last.remaining_after_fen) : '待律师费确定后计算',
      });
    }
    equation.push({
      kind: 'rate', operator: '×', label: rateLabel,
      amount_fen: null, value_text: percentText(formula.result_rate_bps),
    });
    equation.push({
      kind: 'result', operator: '=', label: resultLabel,
      amount_fen: provisional ? null : amountFen,
      value_text: provisional
        ? '待最终方案确定'
        : (amountFen === null
          ? (direction === 'receivable' ? '待实际基数确定' : '待具体款项确认')
          : moneyText(amountFen)),
    });
  }

  return {
    relation_label: relationLabel,
    result_label: resultLabel,
    rate_label: formula.result_kind === 'rate' ? rateLabel : null,
    rate_bps: formula.result_kind === 'rate' ? formula.result_rate_bps : null,
    rate_text: formula.result_kind === 'rate' ? percentText(formula.result_rate_bps) : null,
    headline_kind: formula.result_kind === 'fixed' ? 'amount' : 'rate',
    headline_text: formula.result_kind === 'fixed'
      ? moneyText(formula.result_fixed_fen)
      : percentText(formula.result_rate_bps),
    amount_state: provisional || (formula.result_kind === 'rate' && amountFen === null) ? 'pending' : 'known',
    amount_fen: provisional ? null : (formula.result_kind === 'fixed' ? formula.result_fixed_fen : amountFen),
    provisional: Boolean(provisional),
    pending_deductions: pendingDeductions || '',
    pending_message: provisional
      ? `${pendingDeductions || '前置扣费'}尚未确定，实际分成基数明确后自动计算`
      : (formula.result_kind === 'rate' && amountFen === null
        ? (direction === 'receivable' ? '实际分成基数明确后自动计算' : '在具体律师费行确认后自动计算')
        : ''),
    settlement_term: settlementTerm || '待确定',
    human_summary: humanSummary(formula, { provisional, pendingDeductions }),
    equation,
  };
}
