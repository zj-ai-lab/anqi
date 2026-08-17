// 1.4 结算整数核心：严格 fen/bps、闭合公式、逐步向零、零点钳制和可审计轨迹。
import assert from 'node:assert/strict';
import {
  calculateSettlementFormula,
  fenToYuan,
  fenToYuanString,
  normalizeSettlementFormula,
  parseMoneyToFen,
  parsePercentToBps,
  serializeSettlementFormula,
  summarizeSettlementFormula,
} from '../src/lib/settlement.js';

// 严格元/分与百分比/bps 投影；边界仍须是 JavaScript 安全整数。
assert.equal(parseMoneyToFen('123.45'), 12345);
assert.equal(parseMoneyToFen(-0.01), -1);
assert.equal(parseMoneyToFen('0'), 0);
assert.equal(parseMoneyToFen('90071992547409.91'), Number.MAX_SAFE_INTEGER);
assert.equal(fenToYuan(12345), 123.45);
assert.equal(fenToYuanString(-1), '-0.01');
assert.equal(fenToYuanString(Number.MAX_SAFE_INTEGER), '90071992547409.91');
assert.throws(() => fenToYuanString(Number.MAX_SAFE_INTEGER + 1), /安全整数/);
assert.throws(() => fenToYuan(Number.MAX_SAFE_INTEGER + 1), /安全整数/);
assert.throws(() => fenToYuanString('1'), /安全整数/);
assert.equal(parsePercentToBps('33.33'), 3333);
assert.equal(parsePercentToBps(100), 10000);
assert.throws(() => parseMoneyToFen(null), /十进制字符串或数字/);
assert.throws(() => parseMoneyToFen('1.234'), /格式非法/);
assert.throws(() => parseMoneyToFen(' 1.00'), /格式非法/);
assert.throws(() => parseMoneyToFen(1e-7), /格式非法/);
assert.throws(() => parseMoneyToFen('90071992547409.92'), /安全整数范围/);
assert.throws(() => parsePercentToBps('100.01'), /0% 到 100%/);

// rate terminal 必须显式 gross|remaining；pure fixed 无 deductions 且允许未知 base。
const grossRate = calculateSettlementFormula({
  base_fen: 100000,
  result_kind: 'rate',
  result_basis: 'gross',
  result_rate_bps: 3333,
  deductions: [],
});
assert.equal(grossRate.amount_fen, 33330);
assert.deepEqual(grossRate.trace[0], {
  sequence: 1,
  step: 'result',
  kind: 'rate',
  basis: 'gross',
  basis_fen: 100000,
  rate_bps: 3333,
  calculated_amount_fen: 33330,
  applied_amount_fen: 33330,
  clamped: false,
});
assert.deepEqual(calculateSettlementFormula({
  base_fen: null,
  result_kind: 'fixed',
  result_fixed_fen: 25000,
  deductions: [],
}), {
  amount_fen: 25000,
  trace: [{
    sequence: 1,
    step: 'result',
    kind: 'fixed',
    basis: null,
    basis_fen: null,
    fixed_fen: 25000,
    calculated_amount_fen: 25000,
    applied_amount_fen: 25000,
    clamped: false,
  }],
});
assert.throws(() => normalizeSettlementFormula({
  result_kind: 'rate', result_rate_bps: 5000, deductions: [],
}), /显式指定 result_basis/);
assert.throws(() => calculateSettlementFormula({
  base_fen: null,
  result_kind: 'rate',
  result_basis: 'gross',
  result_rate_bps: 5000,
  deductions: [],
}), /只有纯 fixed/);
assert.throws(() => normalizeSettlementFormula({
  result_kind: 'fixed',
  result_fixed_fen: 100,
  deductions: [{ sequence: 1, label: '不允许', kind: 'fixed', fixed_fen: 10 }],
}), /不得包含扣减/);

// sequence 决定执行顺序：fixed 不带 basis；rate 必须带 label+basis。
const ordered = calculateSettlementFormula({
  base_fen: 10000,
  result_kind: 'rate',
  result_basis: 'remaining',
  result_rate_bps: 5000,
  deductions: [
    { sequence: 2, label: '管理费', kind: 'rate', basis: 'remaining', rate_bps: 1000 },
    { sequence: 1, label: '成本', kind: 'fixed', fixed_fen: 1000 },
  ],
});
assert.equal(ordered.amount_fen, 4050);
assert.deepEqual(ordered.trace.map((step) => step.applied_amount_fen), [1000, 900, 4050]);
assert.deepEqual(ordered.trace.slice(0, 2).map((step) => step.remaining_after_fen), [9000, 8100]);
assert.deepEqual(ordered.trace.slice(0, 2).map((step) => step.clamped), [false, false]);

// 先按 gross 扣 18%，再按 remaining 分 50%：每一步独立向零，不能偷换成 gross × 41%。
const afterFirmCost = calculateSettlementFormula({
  base_fen: 500000,
  result_kind: 'rate',
  result_basis: 'remaining',
  result_rate_bps: 5000,
  deductions: [
    { sequence: 1, label: '律所成本', kind: 'rate', basis: 'gross', rate_bps: 1800 },
  ],
});
assert.equal(afterFirmCost.amount_fen, 205000);
assert.deepEqual(afterFirmCost.trace.map((step) => step.applied_amount_fen), [90000, 205000]);
assert.equal(afterFirmCost.trace[0].remaining_after_fen, 410000);
const stepwiseRounding = calculateSettlementFormula({
  base_fen: 4,
  result_kind: 'rate',
  result_basis: 'remaining',
  result_rate_bps: 5000,
  deductions: [
    { sequence: 1, label: '律所成本', kind: 'rate', basis: 'gross', rate_bps: 1800 },
  ],
});
const simplifiedRate = calculateSettlementFormula({
  base_fen: 4,
  result_kind: 'rate',
  result_basis: 'gross',
  result_rate_bps: 4100,
  deductions: [],
});
assert.equal(stepwiseRounding.amount_fen, 2);
assert.equal(simplifiedRate.amount_fen, 1, '分步取整与 gross × 41% 在分级精度下可能相差一分');

// gross 与 remaining 基数不可混同，terminal 也必须显式选择。
const grossDeduction = calculateSettlementFormula({
  base_fen: 10000,
  result_kind: 'rate',
  result_basis: 'remaining',
  result_rate_bps: 10000,
  deductions: [
    { sequence: 1, label: '成本', kind: 'fixed', fixed_fen: 2000 },
    { sequence: 2, label: 'gross 扣减', kind: 'rate', basis: 'gross', rate_bps: 5000 },
  ],
});
const remainingDeduction = calculateSettlementFormula({
  base_fen: 10000,
  result_kind: 'rate',
  result_basis: 'remaining',
  result_rate_bps: 10000,
  deductions: [
    { sequence: 1, label: '成本', kind: 'fixed', fixed_fen: 2000 },
    { sequence: 2, label: 'remaining 扣减', kind: 'rate', basis: 'remaining', rate_bps: 5000 },
  ],
});
assert.equal(grossDeduction.amount_fen, 3000);
assert.equal(remainingDeduction.amount_fen, 4000);
assert.equal(grossDeduction.trace[1].basis_fen, 10000);
assert.equal(remainingDeduction.trace[1].basis_fen, 8000);

// 每一步独立向零取整；不足一分不会积攒给下一步。
const subCent = calculateSettlementFormula({
  base_fen: 1,
  result_kind: 'rate',
  result_basis: 'remaining',
  result_rate_bps: 5000,
  deductions: [{ sequence: 1, label: '半分扣减', kind: 'rate', basis: 'remaining', rate_bps: 5000 }],
});
assert.deepEqual(subCent.trace.map((step) => step.calculated_amount_fen), [0, 0]);
assert.deepEqual(subCent.trace.map((step) => step.applied_amount_fen), [0, 0]);
assert.equal(calculateSettlementFormula({
  base_fen: -1,
  result_kind: 'rate',
  result_basis: 'gross',
  result_rate_bps: 5000,
  deductions: [],
}).amount_fen, 0, '负数不足一分同样向零');

// 正负基数对称；扣减不得跨零，轨迹同时保留 calculated/applied/clamped。
const positive = calculateSettlementFormula({
  base_fen: 10000,
  result_kind: 'rate',
  result_basis: 'remaining',
  result_rate_bps: 5000,
  deductions: [{ sequence: 1, label: '成本', kind: 'fixed', fixed_fen: 2500 }],
});
const negative = calculateSettlementFormula({
  base_fen: -10000,
  result_kind: 'rate',
  result_basis: 'remaining',
  result_rate_bps: 5000,
  deductions: [{ sequence: 1, label: '退款成本', kind: 'fixed', fixed_fen: 2500 }],
});
assert.equal(negative.amount_fen, -positive.amount_fen);
assert.equal(negative.trace[0].calculated_amount_fen, -positive.trace[0].calculated_amount_fen);
assert.equal(negative.trace[0].applied_amount_fen, -positive.trace[0].applied_amount_fen);
assert.equal(negative.trace[0].remaining_after_fen, -positive.trace[0].remaining_after_fen);

const positiveClamped = calculateSettlementFormula({
  base_fen: 100,
  result_kind: 'rate',
  result_basis: 'remaining',
  result_rate_bps: 10000,
  deductions: [{ sequence: 1, label: '超额固定扣减', kind: 'fixed', fixed_fen: 200 }],
});
assert.deepEqual({
  calculated: positiveClamped.trace[0].calculated_amount_fen,
  applied: positiveClamped.trace[0].applied_amount_fen,
  clamped: positiveClamped.trace[0].clamped,
  remaining: positiveClamped.trace[0].remaining_after_fen,
}, { calculated: 200, applied: 100, clamped: true, remaining: 0 });
assert.equal(positiveClamped.amount_fen, 0);

const negativeClamped = calculateSettlementFormula({
  base_fen: -100,
  result_kind: 'rate',
  result_basis: 'remaining',
  result_rate_bps: 10000,
  deductions: [{ sequence: 1, label: '超额固定扣减', kind: 'fixed', fixed_fen: 200 }],
});
assert.deepEqual({
  calculated: negativeClamped.trace[0].calculated_amount_fen,
  applied: negativeClamped.trace[0].applied_amount_fen,
  clamped: negativeClamped.trace[0].clamped,
  remaining: negativeClamped.trace[0].remaining_after_fen,
}, { calculated: -200, applied: -100, clamped: true, remaining: 0 });
assert.equal(negativeClamped.amount_fen, 0);

const rateClamped = calculateSettlementFormula({
  base_fen: 100,
  result_kind: 'rate',
  result_basis: 'remaining',
  result_rate_bps: 10000,
  deductions: [
    { sequence: 1, label: '先扣', kind: 'fixed', fixed_fen: 80 },
    { sequence: 2, label: '按 gross 再扣', kind: 'rate', basis: 'gross', rate_bps: 5000 },
  ],
});
assert.deepEqual({
  calculated: rateClamped.trace[1].calculated_amount_fen,
  applied: rateClamped.trace[1].applied_amount_fen,
  clamped: rateClamped.trace[1].clamped,
  remaining: rateClamped.trace[1].remaining_after_fen,
}, { calculated: 50, applied: 20, clamped: true, remaining: 0 });

// 定义闭合：label/basis/字段组合/序号/整数比例全部严格。
assert.throws(() => normalizeSettlementFormula({ result_kind: 'expression', deductions: [] }), /result_kind/);
assert.throws(() => normalizeSettlementFormula({
  result_kind: 'rate', result_basis: 'gross', result_rate_bps: 5000,
  deductions: [], expression: 'base * 0.5',
}), /未知字段 expression/);
assert.throws(() => normalizeSettlementFormula({
  result_kind: 'rate', result_basis: 'gross', result_rate_bps: 5000,
  deductions: [{ sequence: 2, label: '缺 1', kind: 'rate', basis: 'gross', rate_bps: 1000 }],
}), /从 1 连续/);
assert.throws(() => normalizeSettlementFormula({
  result_kind: 'rate', result_basis: 'gross', result_rate_bps: 5000,
  deductions: [{ sequence: 1, kind: 'rate', basis: 'gross', rate_bps: 1000 }],
}), /label 必填/);
assert.throws(() => normalizeSettlementFormula({
  result_kind: 'rate', result_basis: 'gross', result_rate_bps: 5000,
  deductions: [{ sequence: 1, label: '无 basis', kind: 'rate', rate_bps: 1000 }],
}), /basis/);
assert.throws(() => normalizeSettlementFormula({
  result_kind: 'rate', result_basis: 'gross', result_rate_bps: 5000,
  deductions: [{ sequence: 1, label: '错误 basis', kind: 'fixed', basis: 'gross', fixed_fen: 1 }],
}), /不得携带 basis/);
assert.throws(() => normalizeSettlementFormula({
  result_kind: 'rate', result_basis: 'gross', result_rate_bps: 5000,
  deductions: [{ sequence: 1, label: '负固定', kind: 'fixed', fixed_fen: -1 }],
}), /非负/);
assert.throws(() => normalizeSettlementFormula({
  result_kind: 'rate', result_basis: 'gross', result_rate_bps: 10001, deductions: [],
}), /1 到 10000/);
assert.throws(() => normalizeSettlementFormula({
  result_kind: 'fixed', result_fixed_fen: 100, result_rate_bps: 5000, deductions: [],
}), /不得携带/);
assert.throws(() => normalizeSettlementFormula({
  result_kind: 'rate', result_basis: 'gross', result_rate_bps: 5000.5, deductions: [],
}), /安全整数/);

// 规范化/序列化稳定，不依赖调用者 deductions 数组顺序。
assert.equal(
  serializeSettlementFormula({
    result_kind: 'rate',
    result_basis: 'remaining',
    result_rate_bps: 5000,
    deductions: [
      { sequence: 2, label: '比例', kind: 'rate', basis: 'remaining', rate_bps: 1000 },
      { sequence: 1, label: '固定', kind: 'fixed', fixed_fen: 100 },
    ],
  }),
  '{"result_kind":"rate","result_basis":"remaining","result_rate_bps":5000,"deductions":[{"sequence":1,"label":"固定","kind":"fixed","fixed_fen":100},{"sequence":2,"label":"比例","kind":"rate","basis":"remaining","rate_bps":1000}]}'
);
assert.equal(
  summarizeSettlementFormula({
    result_kind: 'rate', result_basis: 'gross', result_rate_bps: 3333,
    deductions: [{ sequence: 1, label: '成本', kind: 'fixed', fixed_fen: 100 }],
  }),
  '成本：扣 1.00 元 → 按 gross 的 33.33%'
);

// BigInt 乘除覆盖安全整数边界；所有输入/结果仍必须落回安全整数。
assert.equal(calculateSettlementFormula({
  base_fen: Number.MAX_SAFE_INTEGER,
  result_kind: 'rate',
  result_basis: 'gross',
  result_rate_bps: 10000,
  deductions: [],
}).amount_fen, Number.MAX_SAFE_INTEGER);
assert.throws(() => calculateSettlementFormula({
  base_fen: Number.MAX_SAFE_INTEGER + 1,
  result_kind: 'rate',
  result_basis: 'gross',
  result_rate_bps: 5000,
  deductions: [],
}), /安全整数/);
assert.throws(() => fenToYuanString(Number.MAX_SAFE_INTEGER + 1), /安全整数/);
assert.throws(() => fenToYuan(Number.MIN_SAFE_INTEGER - 1), /安全整数/);
assert.throws(() => calculateSettlementFormula({
  base_fen: 1,
  result_kind: 'fixed',
  result_fixed_fen: Number.MAX_SAFE_INTEGER + 1,
  deductions: [],
}), /安全整数/);

console.log('settlement tests: fen/bps + explicit basis/labels + toward-zero clamping trace + safe integer cases all passed');
