// 外层修复事务组合回归：计划、legacy 事实纠正与结算确认必须参与同一 BEGIN IMMEDIATE。
import assert from 'node:assert/strict';
import { audit, db, withImmediateTransaction } from '../src/db.js';
import {
  confirmSettlement,
  previewSettlement,
  putFeeSharePlans,
} from '../src/lib/settlement-service.js';

function confirmBody(preview) {
  return { ...preview.request, fee_version: preview.fee_version, preview_hash: preview.preview_hash };
}

assert.equal(db.pragma('user_version', { simple: true }), 17, '组合事务测试必须运行在 017');

const caseId = Number(db.prepare(
  `INSERT INTO cases (name,procedure,stage) VALUES ('组合事务示例案（张三）','一审','待裁判')`
).run().lastInsertRowid);
const feeId = Number(db.prepare(
  `INSERT INTO fee_items (case_id,label,amount,amount_fen,status)
   VALUES (?,'组合事务示例款',1000,100000,'unpaid')`
).run(caseId).lastInsertRowid);
const agreementId = Number(db.prepare(
  `INSERT INTO fee_share_agreements (case_id,direction,counterpart,rate,status)
   VALUES (?,'payable','李四',50,'active')`
).run(caseId).lastInsertRowid);
const revisionId = Number(db.prepare(
  `INSERT INTO fee_share_formula_revisions
     (agreement_id,case_id,revision_no,effective_on,label,change_note,
      result_kind,result_basis,result_rate_bps,created_by)
   VALUES (?,?,1,'2026-01-01','五成初始公式','组合事务回归',
           'rate','gross',5000,'test-settlement-transaction')`
).run(agreementId, caseId).lastInsertRowid);
db.prepare(
  `UPDATE fee_share_formula_revisions
      SET sealed=1,sealed_at='2026-01-01 00:00:00',sealed_by='test-settlement-transaction'
    WHERE id=?`
).run(revisionId);
const legacyId = Number(db.prepare(
  `INSERT INTO fee_shares
     (case_id,direction,counterpart,amount,due_month,status,settled_on,entry_kind)
   VALUES (?,'payable','王五',100,'2026-01','settled','2026-01-10','legacy')`
).run(caseId).lastInsertRowid);

// 内层失败即使被外层捕获，也只能回滚内层 savepoint；不能把批量方案的前半段提交。
withImmediateTransaction(() => {
  let caught = null;
  try {
    putFeeSharePlans(feeId, {
      plans: [
        {
          agreement_id: agreementId,
          status: 'assigned',
          formula_revision_id: revisionId,
          revision_choice: 'initial',
          decision_note: '内层失败前的第一项方案',
          version: 0,
        },
        {
          agreement_id: agreementId + 1000000,
          status: 'not_applicable',
          revision_choice: 'not_applicable',
          decision_note: '不存在的第二项约定触发失败',
          version: 0,
        },
      ],
    }, 'test-inner-caught');
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.code, 'agreement_not_active_payable');
  audit('test-outer-catch', 'nested_error_caught', 'transaction_test', null, 'outer continues');
});
assert.equal(
  db.prepare('SELECT COUNT(*) AS count FROM fee_share_assignments').get().count,
  0,
  '被捕获的内层失败不得遗留前半段 assignment'
);
assert.equal(
  db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE actor='test-inner-caught'").get().count,
  0,
  '被捕获的内层失败不得遗留前半段 audit'
);
assert.equal(
  db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE actor='test-outer-catch'").get().count,
  1,
  '外层捕获异常后仍可继续并提交自身工作'
);

const baseline = {
  fee: db.prepare('SELECT status,version FROM fee_items WHERE id=?').get(feeId),
  legacy: db.prepare('SELECT amount,amount_fen FROM fee_shares WHERE id=?').get(legacyId),
  assignments: db.prepare('SELECT COUNT(*) AS count FROM fee_share_assignments').get().count,
  runs: db.prepare('SELECT COUNT(*) AS count FROM fee_share_settlement_runs').get().count,
  snapshots: db.prepare('SELECT COUNT(*) AS count FROM fee_share_settlement_snapshots').get().count,
  audits: db.prepare('SELECT COUNT(*) AS count FROM audit_log').get().count,
};

assert.throws(() => withImmediateTransaction(() => {
  putFeeSharePlans(feeId, {
    agreement_id: agreementId,
    status: 'assigned',
    formula_revision_id: revisionId,
    revision_choice: 'initial',
    decision_note: '人工选择初始公式',
    version: 0,
  }, 'test-outer-rollback');
  db.prepare('UPDATE fee_shares SET amount=90 WHERE id=?').run(legacyId);
  audit('test-outer-rollback', 'repair_fact', 'share', legacyId, '100.00→90.00');
  const preview = previewSettlement(feeId, { run_kind: 'receipt', paid_on: '2026-01-15' });
  confirmSettlement(feeId, confirmBody(preview), 'test-outer-rollback');
  throw new Error('outer rollback sentinel');
}), /outer rollback sentinel/);

assert.deepEqual(
  db.prepare('SELECT status,version FROM fee_items WHERE id=?').get(feeId),
  baseline.fee,
  '外层失败必须回滚 confirm 对 fee 的更新'
);
assert.deepEqual(
  db.prepare('SELECT amount,amount_fen FROM fee_shares WHERE id=?').get(legacyId),
  baseline.legacy,
  '外层失败必须回滚 legacy 事实纠正'
);
assert.equal(
  db.prepare('SELECT COUNT(*) AS count FROM fee_share_assignments').get().count,
  baseline.assignments,
  '外层失败必须回滚嵌套 plan 写入'
);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fee_share_settlement_runs').get().count, baseline.runs);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fee_share_settlement_snapshots').get().count, baseline.snapshots);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_log').get().count, baseline.audits);

const receipt = withImmediateTransaction(() => {
  putFeeSharePlans(feeId, {
    agreement_id: agreementId,
    status: 'assigned',
    formula_revision_id: revisionId,
    revision_choice: 'initial',
    decision_note: '人工选择初始公式',
    version: 0,
  }, 'test-outer-commit');
  db.prepare('UPDATE fee_shares SET amount=90 WHERE id=?').run(legacyId);
  audit('test-outer-commit', 'repair_fact', 'share', legacyId, '100.00→90.00');
  const preview = previewSettlement(feeId, { run_kind: 'receipt', paid_on: '2026-01-15' });
  return confirmSettlement(feeId, confirmBody(preview), 'test-outer-commit');
});
assert.equal(receipt.run.run_kind, 'receipt');
assert.equal(receipt.shares[0].amount_fen, 50000);
assert.deepEqual(db.prepare('SELECT amount,amount_fen FROM fee_shares WHERE id=?').get(legacyId), {
  amount: 90,
  amount_fen: 9000,
});

// 已结同额 correction 是零差额：追加 run/snapshot，但不新增 0 元台账。
db.prepare(
  `UPDATE fee_shares SET status='settled',settled_on='2026-01-20' WHERE id=?`
).run(receipt.shares[0].id);
const correctionInput = {
  run_kind: 'correction',
  source_run_id: receipt.run.id,
  request_id: 'transaction-zero-delta-1',
  base_amount_fen: 100000,
  paid_on: '2026-01-15',
  reason: '金额不变的组合事务回归',
};
const correctionPreview = previewSettlement(feeId, correctionInput);
assert.equal(correctionPreview.settlements[0].closed_amount_fen, 50000);
assert.equal(correctionPreview.settlements[0].new_amount_fen, 0);
const beforeCorrection = {
  legacy: db.prepare('SELECT amount,amount_fen FROM fee_shares WHERE id=?').get(legacyId),
  runs: db.prepare('SELECT COUNT(*) AS count FROM fee_share_settlement_runs').get().count,
  snapshots: db.prepare('SELECT COUNT(*) AS count FROM fee_share_settlement_snapshots').get().count,
  shares: db.prepare('SELECT COUNT(*) AS count FROM fee_shares').get().count,
};

assert.throws(() => withImmediateTransaction(() => {
  db.prepare('UPDATE fee_shares SET amount=80 WHERE id=?').run(legacyId);
  audit('test-correction-rollback', 'repair_fact', 'share', legacyId, '90.00→80.00');
  confirmSettlement(feeId, confirmBody(correctionPreview), 'test-correction-rollback');
  throw new Error('zero-delta rollback sentinel');
}), /zero-delta rollback sentinel/);
assert.deepEqual(
  db.prepare('SELECT amount,amount_fen FROM fee_shares WHERE id=?').get(legacyId),
  beforeCorrection.legacy
);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fee_share_settlement_runs').get().count, beforeCorrection.runs);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fee_share_settlement_snapshots').get().count, beforeCorrection.snapshots);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fee_shares').get().count, beforeCorrection.shares);

const correction = withImmediateTransaction(() => {
  db.prepare('UPDATE fee_shares SET amount=80 WHERE id=?').run(legacyId);
  audit('test-correction-commit', 'repair_fact', 'share', legacyId, '90.00→80.00');
  return confirmSettlement(feeId, confirmBody(correctionPreview), 'test-correction-commit');
});
assert.equal(correction.run.run_kind, 'correction');
assert.equal(correction.snapshots.length, 1);
assert.deepEqual(correction.shares, []);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fee_share_settlement_runs').get().count, beforeCorrection.runs + 1);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fee_share_settlement_snapshots').get().count, beforeCorrection.snapshots + 1);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fee_shares').get().count, beforeCorrection.shares);
assert.deepEqual(db.prepare('SELECT amount,amount_fen FROM fee_shares WHERE id=?').get(legacyId), {
  amount: 80,
  amount_fen: 8000,
});
assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
assert.deepEqual(db.pragma('foreign_key_check'), []);

console.log('settlement transaction tests: caught inner rollback + nested plan/fact repair/confirm commit and rollback passed');
db.close();
