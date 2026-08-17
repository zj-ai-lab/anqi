// v1.6 律师资金卡 view model：只翻译后端计算结果，不在视图层算钱。
import assert from 'node:assert/strict';
import { calculateSettlementFormula } from '../src/lib/settlement.js';
import { createSettlementMoneyView } from '../src/lib/settlement-view.js';

const simpleFormula = {
  result_kind: 'rate',
  result_basis: 'gross',
  result_rate_bps: 3000,
  deductions: [],
};
const simpleCalculation = calculateSettlementFormula({ base_fen: 3000000, ...simpleFormula });
const simple = createSettlementMoneyView({
  direction: 'receivable',
  counterpart: '李律师',
  formula: simpleFormula,
  trace: simpleCalculation.trace,
  baseFen: 3000000,
  amountFen: simpleCalculation.amount_fen,
  settlementTerm: '对方收到律师费当月',
});
assert.equal(simple.relation_label, '李律师应给我');
assert.equal(simple.human_summary, '不先扣费用，按本笔律师费的 30%');
assert.deepEqual(simple.equation.map((row) => [row.operator, row.label, row.value_text]), [
  ['', '本笔律师费', '30,000.00 元'],
  ['×', '我的比例', '30%'],
  ['=', '我应收', '9,000.00 元'],
]);

const deductionFormula = {
  result_kind: 'rate',
  result_basis: 'remaining',
  result_rate_bps: 5000,
  deductions: [{ sequence: 1, label: '律所费用', kind: 'rate', basis: 'gross', rate_bps: 1800 }],
};
const deductionCalculation = calculateSettlementFormula({ base_fen: 500000, ...deductionFormula });
const deduction = createSettlementMoneyView({
  direction: 'payable',
  counterpart: '王律师',
  formula: deductionFormula,
  trace: deductionCalculation.trace,
  baseFen: 500000,
  amountFen: deductionCalculation.amount_fen,
  settlementTerm: '收到律师费当月',
});
assert.equal(deduction.human_summary, '先扣律所费用 18%，再按扣费后金额的 50%');
assert.deepEqual(deduction.equation.map((row) => [row.operator, row.label, row.value_text]), [
  ['', '本笔律师费', '5,000.00 元'],
  ['−', '律所费用', '900.00 元'],
  ['=', '扣费后金额', '4,100.00 元'],
  ['×', '对方比例', '50%'],
  ['=', '我应付', '2,050.00 元'],
]);

const provisional = createSettlementMoneyView({
  direction: 'receivable',
  counterpart: '赵律师',
  formula: { ...simpleFormula, result_rate_bps: 2500 },
  baseFen: null,
  amountFen: null,
  provisional: true,
  pendingDeductions: '税费、律所费用',
  settlementTerm: '对方收到律师费后结算',
});
assert.equal(provisional.headline_text, '25%');
assert.equal(provisional.amount_state, 'pending');
assert.equal(provisional.amount_fen, null);
assert.equal(provisional.pending_message, '税费、律所费用尚未确定，实际分成基数明确后自动计算');
assert.equal(provisional.human_summary, '税费、律所费用待确定，暂按本笔律师费的 25% 记录');
assert.deepEqual(provisional.equation.map((row) => [row.operator, row.label, row.value_text]), [
  ['', '本笔律师费', '待关联实际分成基数'],
  ['−', '税费、律所费用', '方案待确定'],
  ['×', '我的比例', '25%'],
  ['=', '我应收', '待最终方案确定'],
]);

const payableWithoutFee = createSettlementMoneyView({
  direction: 'payable', counterpart: '孙律师', formula: deductionFormula,
  baseFen: null, amountFen: null, settlementTerm: '收到律师费当月',
});
assert.equal(payableWithoutFee.equation[0].value_text, '按参与分成的款项计算');
assert.equal(payableWithoutFee.equation.at(-1).value_text, '待具体款项确认');
assert.equal(payableWithoutFee.pending_message, '在具体律师费行确认后自动计算');

console.log('settlement view tests: simple rate + deductions + provisional + unassigned payable passed');
