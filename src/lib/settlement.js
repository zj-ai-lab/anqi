// 合作分成结算的确定性整数核心。
// 金额只以分（fen）、比例只以基点（bps，10000 = 100%）参与计算；不接受任意表达式。

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const BASIS = new Set(['gross', 'remaining']);
const RESULT_KINDS = new Set(['rate', 'fixed']);
const DEDUCTION_KINDS = new Set(['rate', 'fixed']);
const FORMULA_KEYS = new Set([
  'result_kind', 'result_basis', 'result_rate_bps', 'result_fixed_fen', 'deductions',
]);
const DEDUCTION_KEYS = new Set(['sequence', 'label', 'kind', 'basis', 'fixed_fen', 'rate_bps']);

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} 含未知字段 ${key}`);
  }
}

function assertSafeInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} 必须是安全整数`);
  }
  return value;
}

function safeNumber(value, label) {
  if (value > MAX_SAFE_BIGINT || value < MIN_SAFE_BIGINT) {
    throw new RangeError(`${label} 超出 JavaScript 安全整数范围`);
  }
  return Number(value);
}

function parseScaledDecimal(value, digits, label) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError(`${label} 必须是十进制字符串或数字`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`${label} 必须是有限数字`);
  }

  const text = String(value);
  if (!text || text !== text.trim()) throw new TypeError(`${label} 格式非法`);
  const match = text.match(new RegExp(`^([+-]?)(0|[1-9]\\d*)(?:\\.(\\d{1,${digits}}))?$`));
  if (!match) throw new TypeError(`${label} 格式非法，最多 ${digits} 位小数`);

  const sign = match[1] === '-' ? -1n : 1n;
  const scale = 10n ** BigInt(digits);
  const fraction = (match[3] || '').padEnd(digits, '0');
  const scaled = sign * (BigInt(match[2]) * scale + BigInt(fraction || '0'));
  return safeNumber(scaled, label);
}

/** 严格解析元金额；最多两位小数，返回整数分。 */
export function parseMoneyToFen(value) {
  return parseScaledDecimal(value, 2, '金额');
}

/** 严格解析百分比；最多两位小数，返回整数基点。 */
export function parsePercentToBps(value) {
  const bps = parseScaledDecimal(value, 2, '比例');
  if (bps < 0 || bps > 10000) throw new RangeError('比例须在 0% 到 100% 之间');
  return bps;
}

/** 精确的元字符串投影，供序列化或展示使用。 */
export function fenToYuanString(fen) {
  assertSafeInteger(fen, '分金额');
  const value = BigInt(fen);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** 兼容既有 REAL 元字段的数字投影；不得把此返回值用于后续计算。 */
export function fenToYuan(fen) {
  return Number(fenToYuanString(fen));
}

function normalizedLabel(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('扣减 label 必填');
  return value.trim();
}

function normalizedDeduction(deduction) {
  if (!deduction || typeof deduction !== 'object' || Array.isArray(deduction)) {
    throw new TypeError('扣减步骤必须是对象');
  }
  assertKnownKeys(deduction, DEDUCTION_KEYS, '扣减步骤');
  const sequence = assertSafeInteger(deduction.sequence, '扣减 sequence');
  if (sequence <= 0) throw new RangeError('扣减 sequence 必须从 1 开始');
  const label = normalizedLabel(deduction.label);
  if (!DEDUCTION_KINDS.has(deduction.kind)) throw new TypeError('扣减 kind 只允许 fixed 或 rate');

  if (deduction.kind === 'fixed') {
    if (deduction.basis !== undefined && deduction.basis !== null) {
      throw new TypeError('fixed 扣减不得携带 basis');
    }
    const fixedFen = assertSafeInteger(deduction.fixed_fen, 'fixed_fen');
    if (fixedFen < 0) throw new RangeError('扣减 fixed_fen 必须是非负整数');
    if (deduction.rate_bps !== undefined && deduction.rate_bps !== null) {
      throw new TypeError('fixed 扣减不得携带 rate_bps');
    }
    return { sequence, label, kind: 'fixed', fixed_fen: fixedFen };
  }

  if (!BASIS.has(deduction.basis)) {
    throw new TypeError('rate 扣减须显式指定 basis=gross 或 remaining');
  }
  const rateBps = assertSafeInteger(deduction.rate_bps, 'rate_bps');
  if (rateBps <= 0 || rateBps > 10000) throw new RangeError('扣减 rate_bps 须在 1 到 10000 之间');
  if (deduction.fixed_fen !== undefined && deduction.fixed_fen !== null) {
    throw new TypeError('rate 扣减不得携带 fixed_fen');
  }
  return { sequence, label, kind: 'rate', basis: deduction.basis, rate_bps: rateBps };
}

/** 验证并规范化闭合公式定义；输出字段和步骤顺序稳定。 */
export function normalizeSettlementFormula(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new TypeError('结算公式必须是对象');
  }
  assertKnownKeys(definition, FORMULA_KEYS, '结算公式');
  if (!RESULT_KINDS.has(definition.result_kind)) {
    throw new TypeError('result_kind 只允许 rate 或 fixed');
  }

  const sourceDeductions = definition.deductions ?? [];
  if (!Array.isArray(sourceDeductions)) throw new TypeError('deductions 必须是数组');
  const deductions = sourceDeductions.map(normalizedDeduction).sort((a, b) => a.sequence - b.sequence);
  for (let index = 0; index < deductions.length; index += 1) {
    if (deductions[index].sequence !== index + 1) {
      throw new RangeError('扣减 sequence 必须唯一且从 1 连续递增');
    }
  }

  if (definition.result_kind === 'fixed') {
    if (deductions.length) throw new TypeError('fixed 终值公式不得包含扣减步骤');
    const fixedFen = assertSafeInteger(definition.result_fixed_fen, 'result_fixed_fen');
    if (definition.result_rate_bps !== undefined && definition.result_rate_bps !== null) {
      throw new TypeError('fixed 终值不得携带 result_rate_bps');
    }
    if (definition.result_basis !== undefined && definition.result_basis !== null) {
      throw new TypeError('fixed 终值不得携带 result_basis');
    }
    return { result_kind: 'fixed', result_fixed_fen: fixedFen, deductions };
  }

  const rateBps = assertSafeInteger(definition.result_rate_bps, 'result_rate_bps');
  if (rateBps <= 0 || rateBps > 10000) throw new RangeError('result_rate_bps 须在 1 到 10000 之间');
  if (definition.result_fixed_fen !== undefined && definition.result_fixed_fen !== null) {
    throw new TypeError('rate 终值不得携带 result_fixed_fen');
  }
  if (!BASIS.has(definition.result_basis)) {
    throw new TypeError('rate 终值须显式指定 result_basis=gross 或 remaining');
  }
  return {
    result_kind: 'rate',
    result_basis: definition.result_basis,
    result_rate_bps: rateBps,
    deductions,
  };
}

export const validateSettlementFormula = normalizeSettlementFormula;

function multiplyRateTowardZero(amountFen, rateBps, label) {
  const amount = BigInt(assertSafeInteger(amountFen, '计算基数'));
  const rate = BigInt(assertSafeInteger(rateBps, '计算比例'));
  return safeNumber((amount * rate) / 10000n, label);
}

function absoluteBigInt(value) {
  return value < 0n ? -value : value;
}

function clampDeductionTowardZero(calculatedDeductionFen, remainingFen) {
  const calculated = BigInt(assertSafeInteger(calculatedDeductionFen, '计算扣减金额'));
  const remaining = BigInt(assertSafeInteger(remainingFen, '扣减前余额'));
  if (remaining === 0n || calculated === 0n) return 0;
  const magnitude = absoluteBigInt(calculated) < absoluteBigInt(remaining)
    ? absoluteBigInt(calculated)
    : absoluteBigInt(remaining);
  return safeNumber(remaining < 0n ? -magnitude : magnitude, '实际扣减金额');
}

/**
 * 按固定顺序执行扣减，再执行 terminal result。每一步均以 BigInt 乘除并向零取整。
 * 扣减后的余额绝不跨过零；base_fen 仅可在无扣减的 fixed 终值公式中省略。
 */
export function calculateSettlementFormula({ base_fen, ...definition }) {
  const formula = normalizeSettlementFormula(definition);
  const baseUnknown = base_fen === undefined || base_fen === null;
  if (baseUnknown && formula.result_kind !== 'fixed') {
    throw new TypeError('只有纯 fixed 公式允许未知 base_fen');
  }
  const grossFen = baseUnknown ? null : assertSafeInteger(base_fen, 'base_fen');

  if (formula.result_kind === 'fixed') {
    return {
      amount_fen: formula.result_fixed_fen,
      trace: [{
        sequence: 1,
        step: 'result',
        kind: 'fixed',
        basis: null,
        basis_fen: null,
        fixed_fen: formula.result_fixed_fen,
        calculated_amount_fen: formula.result_fixed_fen,
        applied_amount_fen: formula.result_fixed_fen,
        clamped: false,
      }],
    };
  }

  let remainingFen = grossFen;
  const trace = [];
  for (const deduction of formula.deductions) {
    const beforeFen = remainingFen;
    const basisFen = deduction.kind === 'fixed'
      ? null
      : (deduction.basis === 'gross' ? grossFen : beforeFen);
    let calculatedAmountFen;
    if (deduction.kind === 'fixed') {
      calculatedAmountFen = beforeFen < 0 ? -deduction.fixed_fen : deduction.fixed_fen;
    } else {
      calculatedAmountFen = multiplyRateTowardZero(basisFen, deduction.rate_bps, '比例扣减金额');
    }
    const appliedAmountFen = clampDeductionTowardZero(calculatedAmountFen, beforeFen);
    remainingFen = safeNumber(BigInt(beforeFen) - BigInt(appliedAmountFen), '扣减后余额');
    trace.push({
      sequence: deduction.sequence,
      step: 'deduction',
      label: deduction.label,
      kind: deduction.kind,
      basis: deduction.kind === 'fixed' ? null : deduction.basis,
      basis_fen: basisFen,
      ...(deduction.kind === 'fixed'
        ? { fixed_fen: deduction.fixed_fen }
        : { rate_bps: deduction.rate_bps }),
      calculated_amount_fen: calculatedAmountFen,
      applied_amount_fen: appliedAmountFen,
      clamped: appliedAmountFen !== calculatedAmountFen,
      remaining_before_fen: beforeFen,
      remaining_after_fen: remainingFen,
    });
  }

  const terminalBasisFen = formula.result_basis === 'gross' ? grossFen : remainingFen;
  const amountFen = multiplyRateTowardZero(terminalBasisFen, formula.result_rate_bps, '结算金额');
  trace.push({
    sequence: trace.length + 1,
    step: 'result',
    kind: 'rate',
    basis: formula.result_basis,
    basis_fen: terminalBasisFen,
    rate_bps: formula.result_rate_bps,
    calculated_amount_fen: amountFen,
    applied_amount_fen: amountFen,
    clamped: false,
  });
  return { amount_fen: amountFen, trace };
}

/** 稳定 JSON，用于 preview hash 与不可变快照。 */
export function serializeSettlementFormula(definition) {
  return JSON.stringify(normalizeSettlementFormula(definition));
}

/** 面向 API/UI 的短摘要；计算仍必须调用 calculateSettlementFormula。 */
export function summarizeSettlementFormula(definition) {
  const formula = normalizeSettlementFormula(definition);
  if (formula.result_kind === 'fixed') return `固定 ${fenToYuanString(formula.result_fixed_fen)} 元`;
  const deductions = formula.deductions.map((step) => (
    step.kind === 'fixed'
      ? `${step.label}：扣 ${fenToYuanString(step.fixed_fen)} 元`
      : `${step.label}：扣 ${(step.rate_bps / 100).toFixed(2)}%（${step.basis}）`
  ));
  const terminal = `按 ${formula.result_basis} 的 ${(formula.result_rate_bps / 100).toFixed(2)}%`;
  return [...deductions, terminal].join(' → ');
}
