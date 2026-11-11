// public/js/share-correct.js 的纯逻辑回归——不依赖 DOM，直接跑在 Node 里。
// 守住两条线：① 系统结算生成的分成不得被当成手动记录去改删；
// ② 更正弹层只提交真正变化的字段，且退回待收 / 待分时清掉旧的结清日期。
import assert from 'node:assert/strict';
import {
  canCorrectManualShare,
  describeConflictShare,
  isEngineShare,
  manualShareCorrectionBody,
  shareStatusText,
} from '../public/js/share-correct.js';

const manual = {
  id: 1, direction: 'payable', counterpart: '李四', amount: 300, due_month: '2026-06',
  status: 'settled', settled_on: '2026-06-05', note: '', entry_kind: 'manual',
  settlement_snapshot_id: null, assignment_id: null, is_void: 0,
};

// 1) 来源判定：四种引擎特征任一命中即为引擎行；作废行不可更正。
assert.equal(isEngineShare(manual), false);
assert.equal(isEngineShare({ ...manual, entry_kind: 'legacy' }), false);
assert.equal(isEngineShare({ ...manual, settlement_snapshot_id: 9 }), true);
assert.equal(isEngineShare({ ...manual, assignment_id: 3 }), true);
assert.equal(isEngineShare({ ...manual, entry_kind: 'calculated' }), true);
assert.equal(isEngineShare({ ...manual, entry_kind: 'adjustment' }), true);
assert.equal(canCorrectManualShare(manual), true);
assert.equal(canCorrectManualShare({ ...manual, is_void: 1 }), false);
assert.equal(canCorrectManualShare({ ...manual, entry_kind: 'adjustment' }), false);
assert.equal(canCorrectManualShare(null), false);

const same = { amount: '300', due_month: '2026-06', status: 'settled', settled_on: '2026-06-05', note: '' };

// 2) 没改动 → 空请求体，调用方据此不发请求。
assert.deepEqual(manualShareCorrectionBody(manual, same, '2026-07-01'), { body: {} });

// 3) 只改金额 → 只带 amount（数字），不夹带未变字段。
assert.deepEqual(
  manualShareCorrectionBody(manual, { ...same, amount: '250.50' }, '2026-07-01'),
  { body: { amount: 250.5 } },
);

// 4) 已分退回待分 → 状态变化并清空旧的结清日期（哪怕输入框里还留着旧日期）。
assert.deepEqual(
  manualShareCorrectionBody(manual, { ...same, status: 'pending' }, '2026-07-01'),
  { body: { status: 'pending', settled_on: '' } },
);
assert.deepEqual(
  manualShareCorrectionBody(manual, { ...same, status: 'waived' }, '2026-07-01'),
  { body: { status: 'waived', settled_on: '' } },
);

// 5) 待分改已分且没填日期 → 用当天；填了日期则用所填。
const pending = { ...manual, status: 'pending', settled_on: '' };
assert.deepEqual(
  manualShareCorrectionBody(pending, { ...same, status: 'settled', settled_on: '' }, '2026-07-01'),
  { body: { status: 'settled', settled_on: '2026-07-01' } },
);
assert.deepEqual(
  manualShareCorrectionBody(pending, { ...same, status: 'settled', settled_on: '2026-06-30' }, '2026-07-01'),
  { body: { status: 'settled', settled_on: '2026-06-30' } },
);
// 待分保持待分时，输入框里误填的日期不会被提交。
assert.deepEqual(
  manualShareCorrectionBody(pending, { ...same, status: 'pending', settled_on: '2026-06-30' }, '2026-07-01'),
  { body: {} },
);

// 6) 仅改结清日期、月份、备注。
assert.deepEqual(
  manualShareCorrectionBody(manual, { ...same, settled_on: '2026-06-08', due_month: '2026-05', note: '补记' }, '2026-07-01'),
  { body: { due_month: '2026-05', settled_on: '2026-06-08', note: '补记' } },
);

// 7) 非法输入一律给出人话错误，不产生请求体。负数（冲抵）合法。
for (const amount of ['', '0', '0.00', 'abc', '1.234', '1e3', ' ']) {
  const result = manualShareCorrectionBody(manual, { ...same, amount }, '2026-07-01');
  assert.equal(result.body, undefined, `amount=${JSON.stringify(amount)} 不应产生请求体`);
  assert.match(result.error, /金额/);
}
assert.deepEqual(
  manualShareCorrectionBody(manual, { ...same, amount: '-80' }, '2026-07-01'),
  { body: { amount: -80 } },
);
assert.match(manualShareCorrectionBody(manual, { ...same, due_month: '2026-13' }, '2026-07-01').error, /月份/);
assert.match(manualShareCorrectionBody(manual, { ...same, status: 'paid' }, '2026-07-01').error, /状态/);
assert.match(manualShareCorrectionBody(manual, { ...same, settled_on: '2026/06/05' }, '2026-07-01').error, /日期/);

// 8) 文案：谁给谁、多少钱、什么状态，不出现 payable / receivable / legacy 这类内部词。
assert.equal(shareStatusText(manual), '已分');
assert.equal(shareStatusText({ direction: 'receivable', status: 'pending' }), '待收');
assert.equal(shareStatusText({ direction: 'receivable', status: 'settled' }), '已收');
assert.equal(shareStatusText({ direction: 'payable', status: 'waived' }), '减免');
assert.equal(describeConflictShare(manual), '我应给李四 · ¥300 · 已分 · 2026-06');
assert.equal(
  describeConflictShare({ direction: 'receivable', counterpart: '王五', amount: -1200.5, status: 'pending', due_month: '2026-07' }),
  '王五应给我 · −¥1,200.5 · 待收 · 2026-07',
);
assert.equal(
  describeConflictShare({ direction: 'payable', counterpart: '赵六', status: 'pending' }),
  '我应给赵六 · 待分',
);

console.log('share-correct: 来源判定 + 最小更正请求体 + 输入校验 + 人话文案 通过');
