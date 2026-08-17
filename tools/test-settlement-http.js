import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-settlement-http-'));
const dbPath = path.join(scratchDir, 'settlement.db');
const logPath = path.join(scratchDir, 'server.log');
const port = 40000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const log = fs.openSync(logPath, 'w');
const server = spawn(process.execPath, ['server.js'], {
  cwd: rootDir,
  env: {
    ...process.env,
    DB_PATH: dbPath,
    PORT: String(port),
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    ANJIAN_UNSAFE_NO_AUTH: '1',
  },
  stdio: ['ignore', log, log],
});
let db;

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`server exited with ${server.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not become ready');
}

async function request(method, pathname, body, expected = 200) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
  assert.equal(response.status, expected, `${method} ${pathname}: expected ${expected}, got ${response.status}: ${raw}`);
  return parsed;
}

function createAgreement(caseId, counterpart, rateBps, label) {
  const agreementId = Number(db.prepare(
    `INSERT INTO fee_share_agreements
       (case_id,direction,counterpart,rate,status,updated_at)
     VALUES (?,'payable',?,?, 'active', datetime('now','+8 hours'))`
  ).run(caseId, counterpart, rateBps / 100).lastInsertRowid);
  const revisionId = Number(db.prepare(
    `INSERT INTO fee_share_formula_revisions
       (agreement_id,case_id,revision_no,effective_on,label,change_note,
        result_kind,result_basis,result_rate_bps,created_by)
     VALUES (?,?,1,'2026-01-01',?,'HTTP 回归初始公式','rate','gross',?,'test-http')`
  ).run(agreementId, caseId, label, rateBps).lastInsertRowid);
  db.prepare(
    `UPDATE fee_share_formula_revisions
        SET sealed=1,sealed_at='2026-01-01 00:00:00',sealed_by='test-http'
      WHERE id=?`
  ).run(revisionId);
  return { agreementId, revisionId };
}

function addRevision(caseId, agreementId, revisionNo, rateBps, label, sealedAt) {
  const revisionId = Number(db.prepare(
    `INSERT INTO fee_share_formula_revisions
       (agreement_id,case_id,revision_no,effective_on,label,change_note,
        result_kind,result_basis,result_rate_bps,created_by)
     VALUES (?,?,?,'2026-02-01',?,'HTTP 回归新版公式','rate','gross',?,'test-http')`
  ).run(agreementId, caseId, revisionNo, label, rateBps).lastInsertRowid);
  db.prepare(
    `UPDATE fee_share_formula_revisions
        SET sealed=1,sealed_at=?,sealed_by='test-http'
      WHERE id=?`
  ).run(sealedAt, revisionId);
  return revisionId;
}

function writeCounts() {
  const count = (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  return {
    runs: count('fee_share_settlement_runs'),
    snapshots: count('fee_share_settlement_snapshots'),
    shares: count('fee_shares'),
    audits: count('audit_log'),
  };
}

function confirmBody(preview) {
  return { ...preview.request, fee_version: preview.fee_version, preview_hash: preview.preview_hash };
}

try {
  await waitForServer();
  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  const shapeCase = await request('POST', '/api/cases', {
    name: '公式响应示例案（孙七）', procedure: '一审', client: '孙七',
  });
  const preciseFee = await request('POST', `/api/cases/${shapeCase.id}/fees`, {
    label: '两位小数款', amount: '1234.56', due_on: '2026-01-31',
  });
  assert.equal(preciseFee.amount, 1234.56);
  assert.equal(preciseFee.amount_fen, 123456, 'POST 金额按元接收、以整数分落 canonical 字段');
  const subCentFee = await request('POST', `/api/cases/${shapeCase.id}/fees`, {
    label: '三位小数不应落库', amount: '12.345',
  }, 400);
  assert.equal(subCentFee.code, 'amount_invalid');
  const nonStringLabel = await request('POST', `/api/cases/${shapeCase.id}/fees`, {
    label: 123, amount: '10.00',
  }, 400);
  assert.match(nonStringLabel.error, /label/);
  const shapeFee = await request('POST', `/api/cases/${shapeCase.id}/fees`, {
    label: '公式展示款', amount: '900.00', due_on: '2026-02-01',
  });
  const pristineDeleteFee = await request('POST', `/api/cases/${shapeCase.id}/fees`, {
    label: '无依赖可删除款', amount: '100.00', due_on: '2026-02-02',
  });
  const shapeAgreement = await request('POST', `/api/cases/${shapeCase.id}/share-agreements`, {
    direction: 'payable',
    counterpart: '周八',
    effective_on: '2026-01-01',
    label: '扣费后二成',
    change_note: 'HTTP 响应形状初始公式',
    result_kind: 'rate',
    result_basis: 'remaining',
    result_rate_bps: 2000,
    deductions: [
      { sequence: 1, label: '固定成本', kind: 'fixed', fixed_fen: 1000 },
    ],
  });
  assert.equal(shapeAgreement.rate, 20);
  assert.equal(shapeAgreement.flat_amount, null);
  assert.equal(shapeAgreement.revisions.length, 1);
  assert.deepEqual(shapeAgreement.latest_revision, shapeAgreement.revisions[0]);
  assert.equal(shapeAgreement.latest_revision.deductions[0].fixed_fen, 1000);
  assert.deepEqual(shapeAgreement.latest_revision.formula.deductions[0], {
    sequence: 1, label: '固定成本', kind: 'fixed', fixed_fen: 1000,
  });
  assert.match(shapeAgreement.latest_revision.formula_summary, /20\.00%/);

  const receivableAgreement = await request('POST', `/api/cases/${shapeCase.id}/share-agreements`, {
    direction: 'receivable',
    counterpart: '刘律师',
    note: '暂按 30% 记录，扣税、律所费用待后续确定',
    effective_on: '2026-01-01',
    label: '暂定三成',
    change_note: '先记录暂定比例，前置扣费方案待确定',
    result_kind: 'rate',
    result_basis: 'gross',
    result_rate_bps: 3000,
    deductions: [],
  });
  assert.equal(receivableAgreement.direction, 'receivable');
  assert.equal(receivableAgreement.rate, 30);
  assert.equal(receivableAgreement.latest_revision.result_basis, 'gross');
  assert.equal(receivableAgreement.latest_revision.deductions.length, 0);
  assert.match(receivableAgreement.latest_revision.formula_summary, /30\.00%/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fee_shares WHERE agreement_id = ?')
    .get(receivableAgreement.id).count, 0, '应收比例约定不得提前生成金额未知的应收台账');

  const provisionalPayableAgreement = await request('POST', `/api/cases/${shapeCase.id}/share-agreements`, {
    direction: 'payable',
    counterpart: '赵六',
    note: '暂按 25% 记录，税费与律所费用待确定',
    settlement_term: '收到律师费当月',
    effective_on: '2026-01-01',
    label: '暂定四分之一',
    change_note: '先记录比例，扣费方案待确定',
    is_provisional: true,
    pending_deductions: '税费、律所费用',
    result_kind: 'rate',
    result_basis: 'gross',
    result_rate_bps: 2500,
    deductions: [],
  });
  assert.equal(provisionalPayableAgreement.latest_revision.is_provisional, 1);
  assert.equal(provisionalPayableAgreement.latest_revision.pending_deductions, '税费、律所费用');
  const provisionalAssignment = await request('PUT', `/api/fees/${shapeFee.id}/share-plans`, {
    agreement_id: provisionalPayableAgreement.id,
    status: 'assigned',
    formula_revision_id: provisionalPayableAgreement.latest_revision.id,
    revision_choice: 'initial',
    decision_note: '暂定公式不应进入正式结算',
    version: 0,
  }, 409);
  assert.equal(provisionalAssignment.code, 'provisional_formula_not_assignable');
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM fee_share_assignments WHERE fee_item_id = ? AND agreement_id = ?'
  ).get(shapeFee.id, provisionalPayableAgreement.id).count, 0,
  '被拒绝的暂定应付公式不得留下 assignment');

  const shapePlanBundle = await request('GET', `/api/fees/${shapeFee.id}/share-plans`);
  assert(!shapePlanBundle.agreements.some((agreement) => agreement.id === receivableAgreement.id),
    '应收约定不得进入我方收费的 payable 方案门槛');

  const shapeRevision = await request('POST', `/api/share-agreements/${shapeAgreement.id}/revisions`, {
    effective_on: '2026-02-01',
    label: '双扣费后二成五',
    change_note: 'HTTP 响应形状新版公式',
    result_kind: 'rate',
    result_basis: 'gross',
    result_rate_bps: 2500,
    deductions: [
      { sequence: 2, label: '平台费', kind: 'rate', basis: 'remaining', rate_bps: 500 },
      { sequence: 1, label: '固定成本', kind: 'fixed', fixed_fen: 2000 },
    ],
  });
  assert.equal(shapeRevision.revision_no, 2);
  assert.deepEqual(shapeRevision.deductions.map((step) => step.sequence), [1, 2]);
  assert.deepEqual(shapeRevision.formula.deductions, [
    { sequence: 1, label: '固定成本', kind: 'fixed', fixed_fen: 2000 },
    { sequence: 2, label: '平台费', kind: 'rate', basis: 'remaining', rate_bps: 500 },
  ]);
  const patchedShapeAgreement = await request('PATCH', `/api/share-agreements/${shapeAgreement.id}`, {
    note: '统一响应形状回归',
  });
  assert.equal(patchedShapeAgreement.note, '统一响应形状回归');
  assert.equal(patchedShapeAgreement.revisions.length, 2);
  assert.deepEqual(patchedShapeAgreement.latest_revision, patchedShapeAgreement.revisions[1]);
  const shapeShares = await request('GET', `/api/cases/${shapeCase.id}/shares`);
  const listedShapeAgreement = shapeShares.agreements.find((agreement) => agreement.id === shapeAgreement.id);
  const listedReceivableAgreement = shapeShares.agreements.find((agreement) => agreement.id === receivableAgreement.id);
  assert.equal(listedShapeAgreement.revisions.length, 2);
  assert.deepEqual(listedShapeAgreement.latest_revision, listedShapeAgreement.revisions[1]);
  assert.equal(listedShapeAgreement.rate, 25);
  assert.equal(listedShapeAgreement.counterpart, '周八');
  assert.equal(listedReceivableAgreement.direction, 'receivable');
  assert.equal(listedReceivableAgreement.latest_revision.result_rate_bps, 3000);
  assert.equal(shapeShares.items.length, 0, '仅有双向约定时不应出现已发生分成台账');
  await request('DELETE', `/api/fees/${pristineDeleteFee.id}`);
  assert.equal(db.prepare('SELECT 1 FROM fee_items WHERE id = ?').get(pristineDeleteFee.id), undefined,
    'active case agreement alone must not block deleting an unlinked fee');

  const primaryCase = await request('POST', '/api/cases', {
    name: '结算回归示例案（张三）', procedure: '一审', client: '张三',
  });
  const primaryFee = await request('POST', `/api/cases/${primaryCase.id}/fees`, {
    label: '首期示例款', amount: '1000.00', due_on: '2026-03-01',
  });
  const agreementA = createAgreement(primaryCase.id, '李四', 5000, '五成分成');
  const agreementB = createAgreement(primaryCase.id, '王五', 1000, '一成备选');

  const blockedPatch = await request('PATCH', `/api/fees/${primaryFee.id}`, { status: 'paid' }, 409);
  assert.equal(blockedPatch.code, 'settlement_preview_required');

  let plans = await request('PUT', `/api/fees/${primaryFee.id}/share-plans`, {
    agreement_id: agreementA.agreementId,
    status: 'assigned',
    formula_revision_id: agreementA.revisionId,
    revision_choice: 'initial',
    decision_note: '人工选择初始公式',
    version: 0,
  });
  assert.equal(plans.agreements.find((row) => row.id === agreementA.agreementId).plan.version, 1);

  addRevision(primaryCase.id, agreementA.agreementId, 2, 6000, '六成新版', '2099-01-01 00:00:00');
  const beforeUnresolvedPreview = writeCounts();
  const unresolved = await request('POST', `/api/fees/${primaryFee.id}/settlements/preview`, {
    run_kind: 'receipt', paid_on: '2026-03-01',
  }, 409);
  assert.equal(unresolved.code, 'settlement_plan_unresolved');
  assert.deepEqual(writeCounts(), beforeUnresolvedPreview, 'unresolved preview must write nothing');
  assert(unresolved.unresolved_active_payable_agreements.some((row) => row.agreement_id === agreementA.agreementId));
  assert(unresolved.unresolved_active_payable_agreements.some((row) => row.agreement_id === agreementB.agreementId));

  plans = await request('PUT', `/api/fees/${primaryFee.id}/share-plans`, {
    agreement_id: agreementA.agreementId,
    status: 'assigned',
    formula_revision_id: agreementA.revisionId,
    revision_choice: 'keep_current',
    decision_note: '人工确认保留五成版本',
    version: 1,
  });
  assert.equal(plans.agreements.find((row) => row.id === agreementA.agreementId).plan.version, 2);
  const stalePlan = await request('PUT', `/api/fees/${primaryFee.id}/share-plans`, {
    agreement_id: agreementA.agreementId,
    status: 'assigned',
    formula_revision_id: agreementA.revisionId,
    revision_choice: 'keep_current',
    decision_note: '陈旧版本不应成功',
    version: 1,
  }, 409);
  assert.equal(stalePlan.code, 'assignment_version_conflict');

  await request('PUT', `/api/fees/${primaryFee.id}/share-plans`, {
    agreement_id: agreementB.agreementId,
    status: 'not_applicable',
    revision_choice: 'not_applicable',
    decision_note: '本款人工确认不适用',
    version: 0,
  });

  const receiptInput = { run_kind: 'receipt', paid_on: '2026-03-01' };
  const beforeReceiptPreview = writeCounts();
  const receiptPreview = await request('POST', `/api/fees/${primaryFee.id}/settlements/preview`, receiptInput);
  const receiptPreviewAgain = await request('POST', `/api/fees/${primaryFee.id}/settlements/preview`, receiptInput);
  assert.equal(receiptPreview.preview_hash, receiptPreviewAgain.preview_hash, 'same facts must produce same hash');
  assert.deepEqual(writeCounts(), beforeReceiptPreview, 'successful preview must write nothing');
  assert.equal(receiptPreview.settlements.length, 1);
  assert.equal(receiptPreview.settlements[0].desired_amount_fen, 50000);
  const beforeMissingFeeVersion = writeCounts();
  const missingFeeVersion = await request('POST', `/api/fees/${primaryFee.id}/settlements/confirm`, {
    ...receiptPreview.request,
    preview_hash: receiptPreview.preview_hash,
  }, 400);
  assert.equal(missingFeeVersion.code, 'fee_version_required');
  assert.deepEqual(writeCounts(), beforeMissingFeeVersion, 'confirm without fee version must write nothing');

  await request('PUT', `/api/fees/${primaryFee.id}/share-plans`, {
    agreement_id: agreementA.agreementId,
    status: 'assigned',
    formula_revision_id: agreementA.revisionId,
    revision_choice: 'keep_current',
    decision_note: '预览后再次确认保留，制造陈旧预览',
    version: 2,
  });
  const beforeStaleConfirm = writeCounts();
  const staleConfirm = await request(
    'POST', `/api/fees/${primaryFee.id}/settlements/confirm`, confirmBody(receiptPreview), 409
  );
  assert.equal(staleConfirm.code, 'settlement_preview_stale');
  assert.deepEqual(writeCounts(), beforeStaleConfirm, 'stale confirm must roll back fully');

  const freshReceiptPreview = await request('POST', `/api/fees/${primaryFee.id}/settlements/preview`, receiptInput);
  const receipt = await request(
    'POST', `/api/fees/${primaryFee.id}/settlements/confirm`, confirmBody(freshReceiptPreview)
  );
  assert.equal(receipt.idempotent, false);
  assert.equal(receipt.run.run_kind, 'receipt');
  assert.equal(receipt.shares[0].amount_fen, 50000);
  const receiptRetry = await request(
    'POST', `/api/fees/${primaryFee.id}/settlements/confirm`, confirmBody(freshReceiptPreview)
  );
  assert.equal(receiptRetry.idempotent, true);
  assert.equal(receiptRetry.run.id, receipt.run.id);

  await request('PATCH', `/api/shares/${receipt.shares[0].id}`, { status: 'settled', settled_on: '2026-03-05' });
  const zeroDeltaPreview = await request('POST', `/api/fees/${primaryFee.id}/settlements/preview`, {
    run_kind: 'correction',
    source_run_id: receipt.run.id,
    request_id: 'http-zero-delta-1',
    base_amount_fen: 100000,
    paid_on: '2026-03-01',
    reason: '金额不变但确认结算链',
  });
  assert.equal(zeroDeltaPreview.settlements[0].desired_amount_fen, 50000);
  assert.equal(zeroDeltaPreview.settlements[0].closed_amount_fen, 50000);
  assert.equal(zeroDeltaPreview.settlements[0].new_amount_fen, 0);
  const beforeZeroDeltaConfirm = writeCounts();
  const zeroDelta = await request(
    'POST', `/api/fees/${primaryFee.id}/settlements/confirm`, confirmBody(zeroDeltaPreview)
  );
  assert.equal(zeroDelta.snapshots.length, 1);
  assert.deepEqual(zeroDelta.shares, []);
  assert.deepEqual(writeCounts(), {
    runs: beforeZeroDeltaConfirm.runs + 1,
    snapshots: beforeZeroDeltaConfirm.snapshots + 1,
    shares: beforeZeroDeltaConfirm.shares,
    audits: beforeZeroDeltaConfirm.audits + 1,
  }, 'zero-delta confirm must keep run/snapshot/audit without a zero-value ledger row');

  const protectedPatch = await request('PATCH', `/api/fees/${primaryFee.id}`, { amount: '1200.00' }, 409);
  assert.equal(protectedPatch.code, 'settlement_preview_required');

  const correctionInput = {
    run_kind: 'correction',
    source_run_id: zeroDelta.run.id,
    request_id: 'http-correction-1',
    base_amount_fen: 120000,
    paid_on: '2026-04-01',
    reason: '人工更正收款金额',
  };
  const correctionPreview = await request(
    'POST', `/api/fees/${primaryFee.id}/settlements/preview`, correctionInput
  );
  assert.equal(correctionPreview.settlements[0].desired_amount_fen, 60000);
  assert.equal(correctionPreview.settlements[0].closed_amount_fen, 50000);
  assert.equal(correctionPreview.settlements[0].new_amount_fen, 10000);
  const correction = await request(
    'POST', `/api/fees/${primaryFee.id}/settlements/confirm`, confirmBody(correctionPreview)
  );
  assert.equal(correction.fee.amount_fen, 120000);
  assert.equal(correction.shares[0].amount_fen, 10000);
  const correctionRetry = await request(
    'POST', `/api/fees/${primaryFee.id}/settlements/confirm`, confirmBody(correctionPreview)
  );
  assert.equal(correctionRetry.idempotent, true);
  const requestConflict = await request('POST', `/api/fees/${primaryFee.id}/settlements/confirm`, {
    ...confirmBody(correctionPreview), reason: '同 request_id 的不同事实',
  }, 409);
  assert.equal(requestConflict.code, 'settlement_idempotency_conflict');

  const reversalPreview = await request('POST', `/api/fees/${primaryFee.id}/settlements/preview`, {
    run_kind: 'reversal',
    source_run_id: correction.run.id,
    request_id: 'http-reversal-1',
    reason: '人工撤销收讫',
  });
  assert.equal(reversalPreview.settlements[0].desired_amount_fen, 0);
  assert.equal(reversalPreview.settlements[0].closed_amount_fen, 50000);
  assert.equal(reversalPreview.settlements[0].new_amount_fen, -50000);
  const reversal = await request(
    'POST', `/api/fees/${primaryFee.id}/settlements/confirm`, confirmBody(reversalPreview)
  );
  assert.equal(reversal.fee.status, 'unpaid');
  assert.equal(reversal.fee.paid_on, '');
  assert.equal(reversal.shares[0].amount_fen, -50000);
  const beforeHistoryWaive = writeCounts();
  const historyWaive = await request('PATCH', `/api/fees/${primaryFee.id}`, {
    status: 'waived', version: reversal.fee.version,
  }, 409);
  assert.equal(historyWaive.code, 'settlement_preview_required');
  assert.equal(historyWaive.settlement_context.settlement_history, true);
  assert.deepEqual(writeCounts(), beforeHistoryWaive, '有结算历史的 unpaid 款不得直接减免或产生写入');

  const reReceiptPreview = await request('POST', `/api/fees/${primaryFee.id}/settlements/preview`, {
    run_kind: 'correction',
    source_run_id: reversal.run.id,
    request_id: 'http-rereceipt-1',
    base_amount_fen: 140000,
    paid_on: '2026-05-01',
    reason: '冲销后再次收讫',
  });
  assert.equal(reReceiptPreview.settlements[0].desired_amount_fen, 70000);
  assert.equal(reReceiptPreview.settlements[0].closed_amount_fen, 50000);
  assert.equal(reReceiptPreview.settlements[0].new_amount_fen, 20000);
  const reReceipt = await request(
    'POST', `/api/fees/${primaryFee.id}/settlements/confirm`, confirmBody(reReceiptPreview)
  );
  assert.equal(reReceipt.fee.status, 'paid');
  assert.equal(reReceipt.shares[0].amount_fen, 20000);
  await request('PATCH', `/api/share-agreements/${agreementA.agreementId}`, {
    counterpart: '李四（更名）',
  });
  assert.equal(
    db.prepare('SELECT counterpart FROM fee_share_settlement_snapshots WHERE id=?')
      .get(reReceipt.snapshots[0].id).counterpart,
    '李四',
    'agreement 更名不得改写既有 snapshot 身份'
  );
  const reReceiptSettled = await request('PATCH', `/api/shares/${reReceipt.shares[0].id}`, {
    status: 'settled', settled_on: '2026-05-05',
  });
  assert.equal(reReceiptSettled.status, 'settled',
    '同一 engine 历史链已有更早 settled 行时，当前 adjustment 仍须可正常结清');

  const legacyCase = await request('POST', '/api/cases', {
    name: '已收纳管示例案（李四）', procedure: '一审', client: '李四',
  });
  const legacyFee = await request('POST', `/api/cases/${legacyCase.id}/fees`, {
    label: '历史已收示例款', amount: '500.00',
  });
  const safelyPaid = await request('PATCH', `/api/fees/${legacyFee.id}`, {
    status: 'paid', paid_on: '2026-02-01',
  });
  assert.equal(safelyPaid.status, 'paid', 'no-share legacy fee may still use safe generic PATCH');
  const paidToWaived = await request('PATCH', `/api/fees/${legacyFee.id}`, {
    status: 'waived', version: safelyPaid.version,
  }, 409);
  assert.equal(paidToWaived.code, 'fee_status_transition_invalid');
  assert.equal(db.prepare('SELECT status FROM fee_items WHERE id=?').get(legacyFee.id).status, 'paid');
  const safelyUnpaid = await request('PATCH', `/api/fees/${legacyFee.id}`, {
    status: 'unpaid', version: safelyPaid.version,
  });
  assert.equal(safelyUnpaid.status, 'unpaid');
  assert.equal(safelyUnpaid.paid_on, '', 'paid→unpaid 必须同步清空 paid_on');
  const safelyRepaid = await request('PATCH', `/api/fees/${legacyFee.id}`, {
    status: 'paid', paid_on: '2026-02-01', version: safelyUnpaid.version,
  });
  assert.equal(safelyRepaid.status, 'paid');
  const legacyAgreement = createAgreement(legacyCase.id, '赵六', 5000, '历史款五成');
  await request('PUT', `/api/fees/${legacyFee.id}/share-plans`, {
    agreement_id: legacyAgreement.agreementId,
    status: 'assigned',
    formula_revision_id: legacyAgreement.revisionId,
    revision_choice: 'initial',
    decision_note: '人工纳管已收历史款',
    version: 0,
  });
  const adoptionPreview = await request('POST', `/api/fees/${legacyFee.id}/settlements/preview`, {
    run_kind: 'receipt', paid_on: '2026-02-01',
  });
  const adoption = await request(
    'POST', `/api/fees/${legacyFee.id}/settlements/confirm`, confirmBody(adoptionPreview)
  );
  assert.equal(adoption.run.run_kind, 'receipt');
  assert.equal(adoption.shares[0].amount_fen, 25000);

  const retiredCase = await request('POST', '/api/cases', {
    name: '退役历史示例案（王五）', procedure: '一审', client: '王五',
  });
  const retiredFee = await request('POST', `/api/cases/${retiredCase.id}/fees`, {
    label: '退役约定示例款', amount: '800.00', due_on: '2026-01-10',
  });
  const retiredAgreement = createAgreement(retiredCase.id, '赵六', 2500, '四分之一初版');
  await request('PUT', `/api/fees/${retiredFee.id}/share-plans`, {
    agreement_id: retiredAgreement.agreementId,
    status: 'assigned',
    formula_revision_id: retiredAgreement.revisionId,
    revision_choice: 'initial',
    decision_note: '人工选择退役前初版',
    version: 0,
  });
  const retiredReceiptPreview = await request('POST', `/api/fees/${retiredFee.id}/settlements/preview`, {
    run_kind: 'receipt', paid_on: '2026-01-10',
  });
  const retiredReceipt = await request(
    'POST', `/api/fees/${retiredFee.id}/settlements/confirm`, confirmBody(retiredReceiptPreview)
  );
  assert.equal(retiredReceipt.shares[0].amount_fen, 20000);
  await request('PATCH', `/api/shares/${retiredReceipt.shares[0].id}`, {
    status: 'settled', settled_on: '2026-01-15',
  });
  const retiredRevision2 = addRevision(
    retiredCase.id, retiredAgreement.agreementId, 2, 3000, '三成新版', '2026-02-01 00:00:00'
  );
  await request('PUT', `/api/fees/${retiredFee.id}/share-plans`, {
    agreement_id: retiredAgreement.agreementId,
    status: 'assigned',
    formula_revision_id: retiredRevision2,
    revision_choice: 'adopt_latest',
    decision_note: '退役前人工采用三成新版',
    version: 1,
  });
  await request('DELETE', `/api/share-agreements/${retiredAgreement.agreementId}`);
  assert.equal(
    db.prepare('SELECT status FROM fee_share_agreements WHERE id = ?').get(retiredAgreement.agreementId).status,
    'retired'
  );

  const retiredReversalPreview = await request('POST', `/api/fees/${retiredFee.id}/settlements/preview`, {
    run_kind: 'reversal',
    source_run_id: retiredReceipt.run.id,
    request_id: 'http-retired-reversal-1',
    reason: '退役后冲销初版收讫',
  });
  assert.equal(retiredReversalPreview.settlements[0].formula_revision_id, retiredAgreement.revisionId,
    'reversal must reuse source revision after assignment explicitly adopted a newer revision');
  assert.equal(retiredReversalPreview.settlements[0].plan_version, 1,
    'reversal must reuse source plan version instead of current assignment version');
  assert.equal(retiredReversalPreview.settlements[0].new_amount_fen, -20000);
  const retiredReversal = await request(
    'POST', `/api/fees/${retiredFee.id}/settlements/confirm`, confirmBody(retiredReversalPreview)
  );
  assert.equal(retiredReversal.fee.status, 'unpaid');
  assert.equal(retiredReversal.shares[0].amount_fen, -20000);

  const retiredCorrectionPreview = await request('POST', `/api/fees/${retiredFee.id}/settlements/preview`, {
    run_kind: 'correction',
    source_run_id: retiredReversal.run.id,
    request_id: 'http-retired-correction-1',
    base_amount_fen: 100000,
    paid_on: '2026-03-01',
    reason: '退役历史约定再次收讫',
  });
  assert.equal(retiredCorrectionPreview.settlements[0].agreement_status, 'retired');
  assert.equal(retiredCorrectionPreview.settlements[0].formula_revision_id, retiredRevision2);
  assert.equal(retiredCorrectionPreview.settlements[0].desired_amount_fen, 30000);
  assert.equal(retiredCorrectionPreview.settlements[0].closed_amount_fen, 20000);
  assert.equal(retiredCorrectionPreview.settlements[0].new_amount_fen, 10000);
  const retiredCorrection = await request(
    'POST', `/api/fees/${retiredFee.id}/settlements/confirm`, confirmBody(retiredCorrectionPreview)
  );
  assert.equal(retiredCorrection.fee.status, 'paid');
  assert.equal(retiredCorrection.shares[0].amount_fen, 10000);
  assert.equal(
    db.prepare('SELECT status FROM fee_share_agreements WHERE id = ?').get(retiredAgreement.agreementId).status,
    'retired',
    'historical correction must not reactivate the agreement'
  );

  const caseFees = await request('GET', `/api/cases/${primaryCase.id}/fees`);
  const enrichedFee = caseFees.items.find((fee) => fee.id === primaryFee.id);
  assert(enrichedFee, 'case fees must include primary fee');
  assert.equal(enrichedFee.unresolved_active_payable_agreements.length, 0);
  assert.equal(enrichedFee.settlement_runs.length, 5);
  const detailedHistory = enrichedFee.settlement_runs.find((run) => run.snapshots.length);
  assert(detailedHistory.snapshots[0].formula, 'refreshed settlement history must retain frozen formula');
  assert(Array.isArray(detailedHistory.snapshots[0].trace), 'refreshed settlement history must retain calculation trace');
  assert.equal(typeof detailedHistory.snapshots[0].formula_summary, 'string');
  assert.equal(Number.isInteger(detailedHistory.snapshots[0].revision_no), true);
  const freshPlanBundle = await request('GET', `/api/fees/${primaryFee.id}/share-plans`);
  assert.equal(freshPlanBundle.settlement_runs.length, 5,
    'plan editor read must include the fresh settlement chain used to choose correction/reversal');
  assert(Array.isArray(freshPlanBundle.settlement_runs[0].snapshots[0].trace));
  assert.equal(enrichedFee.share_plans.length, 2);
  const enrichedPlan = enrichedFee.share_plans.find((agreement) => agreement.id === agreementA.agreementId).plan;
  assert.equal(enrichedPlan.projected_amount_fen, 70000);
  assert.match(enrichedPlan.formula_summary, /50\.00%/);
  assert.deepEqual(enrichedFee.shares.map((share) => share.amount_fen).sort((a, b) => a - b), [20000, 50000]);
  assert(!enrichedFee.shares.some((share) => share.id === correction.shares[0].id), 'cancelled correction row must be hidden');
  assert(!enrichedFee.shares.some((share) => share.id === reversal.shares[0].id), 'cancelled reversal row must be hidden');

  const overview = await request('GET', '/api/fees/overview');
  assert('date' in overview && 'totals' in overview && Array.isArray(overview.cases));
  const overviewFee = overview.cases
    .find((item) => item.case_id === primaryCase.id).items
    .find((fee) => fee.id === primaryFee.id);
  assert.equal(overviewFee.share_plans[0].latest_revision.formula_summary.length > 0, true);
  assert.equal(overviewFee.unresolved_active_payable_agreements.length, 0);
  assert.deepEqual(overviewFee.shares.map((share) => share.amount_fen).sort((a, b) => a - b), [20000, 50000]);
  const overviewShapeCase = overview.cases.find((item) => item.case_id === shapeCase.id);
  const overviewShapeAgreement = overviewShapeCase.agreements.find(
    (agreement) => agreement.id === shapeAgreement.id
  );
  assert.deepEqual(overviewShapeAgreement, listedShapeAgreement,
    'case and fees agreement reads must share one complete revision response contract');
  const sharesOverview = await request('GET', '/api/shares/overview');
  const globalReceivableAgreement = sharesOverview.agreements.find(
    (agreement) => agreement.id === receivableAgreement.id
  );
  assert.equal(globalReceivableAgreement.case_name, shapeCase.name);
  assert.equal(globalReceivableAgreement.latest_revision.result_rate_bps, 3000);
  assert(!sharesOverview.items.some((share) => share.agreement_id === receivableAgreement.id),
    '全局分成页应展示暂定应收约定，但不得伪造待收金额台账');

  const confirmedDelete = await request('DELETE', `/api/fees/${primaryFee.id}`, undefined, 409);
  assert.equal(confirmedDelete.code, 'fee_delete_blocked_by_settlement_context');
  assert.equal(confirmedDelete.settlement_context.settlement_history, true);
  assert(db.prepare('SELECT 1 FROM fee_items WHERE id = ?').get(primaryFee.id));

  const planOnlyCase = await request('POST', '/api/cases', {
    name: '仅方案删除保护案（张三）', procedure: '一审', client: '张三',
  });
  const planOnlyFee = await request('POST', `/api/cases/${planOnlyCase.id}/fees`, {
    label: '仅有方案款', amount: '300.00', due_on: '2026-06-01',
  });
  const planOnlyAgreement = createAgreement(planOnlyCase.id, '李四', 1000, '一成方案');
  await request('PUT', `/api/fees/${planOnlyFee.id}/share-plans`, {
    agreement_id: planOnlyAgreement.agreementId,
    status: 'assigned',
    formula_revision_id: planOnlyAgreement.revisionId,
    revision_choice: 'initial',
    decision_note: '仅建立方案用于删除保护回归',
    version: 0,
  });
  const planBeforeWaiver = db.prepare(
    `SELECT id,status,formula_revision_id,version FROM fee_share_assignments
      WHERE fee_item_id=? AND agreement_id=?`
  ).get(planOnlyFee.id, planOnlyAgreement.agreementId);
  await request('DELETE', `/api/share-agreements/${planOnlyAgreement.agreementId}`);
  const planOnlyReadAfterRetire = (await request('GET', `/api/cases/${planOnlyCase.id}/fees`))
    .items.find((fee) => fee.id === planOnlyFee.id);
  assert.equal(planOnlyReadAfterRetire.share_plans.length, 0,
    '退役约定不再进入 active share_plans');
  assert.equal(planOnlyReadAfterRetire.settlement_context.assignment, true,
    '读模型必须显式保留退役约定留下的 assignment，供前端正确隐藏删除');
  const overviewPlanOnly = (await request('GET', '/api/fees/overview')).cases
    .flatMap((group) => group.items).find((fee) => fee.id === planOnlyFee.id);
  assert.equal(overviewPlanOnly.settlement_context.assignment, true,
    'overview 批量 context 与单案读模型须保持一致');
  const planOnlyFinancialCounts = () => ({
    runs: db.prepare('SELECT COUNT(*) AS count FROM fee_share_settlement_runs WHERE fee_item_id=?')
      .get(planOnlyFee.id).count,
    snapshots: db.prepare('SELECT COUNT(*) AS count FROM fee_share_settlement_snapshots WHERE fee_item_id=?')
      .get(planOnlyFee.id).count,
    shares: db.prepare('SELECT COUNT(*) AS count FROM fee_shares WHERE fee_item_id=? AND is_void=0')
      .get(planOnlyFee.id).count,
  });
  const financialBeforeWaiver = planOnlyFinancialCounts();
  const planOnlyWaived = await request('PATCH', `/api/fees/${planOnlyFee.id}`, {
    status: 'waived', version: planOnlyFee.version,
  });
  assert.equal(planOnlyWaived.status, 'waived');
  assert.equal(planOnlyWaived.paid_on, '');
  assert.equal(planOnlyWaived.version, planOnlyFee.version + 1);
  const waivedToPaid = await request('PATCH', `/api/fees/${planOnlyFee.id}`, {
    status: 'paid', version: planOnlyWaived.version,
  }, 409);
  assert.equal(waivedToPaid.code, 'fee_status_transition_invalid');
  const staleRestore = await request('PATCH', `/api/fees/${planOnlyFee.id}`, {
    status: 'unpaid', version: planOnlyFee.version,
  }, 409);
  assert.equal(staleRestore.code, 'fee_version_conflict');
  const planOnlyRestored = await request('PATCH', `/api/fees/${planOnlyFee.id}`, {
    status: 'unpaid', version: planOnlyWaived.version,
  });
  assert.equal(planOnlyRestored.status, 'unpaid');
  assert.equal(planOnlyRestored.paid_on, '');
  assert.equal(planOnlyRestored.version, planOnlyWaived.version + 1);
  assert.deepEqual(planOnlyFinancialCounts(), financialBeforeWaiver,
    'assignment-only 减免/恢复不得制造 run、snapshot 或真实 share');
  assert.deepEqual(db.prepare(
    `SELECT id,status,formula_revision_id,version FROM fee_share_assignments
      WHERE fee_item_id=? AND agreement_id=?`
  ).get(planOnlyFee.id, planOnlyAgreement.agreementId), planBeforeWaiver,
  'assignment-only 减免/恢复须原样保留方案');
  const planOnlyDelete = await request('DELETE', `/api/fees/${planOnlyFee.id}`, undefined, 409);
  assert.equal(planOnlyDelete.code, 'fee_delete_blocked_by_settlement_context');
  assert.equal(planOnlyDelete.settlement_context.assignment, true);
  assert(db.prepare('SELECT 1 FROM fee_items WHERE id = ?').get(planOnlyFee.id));

  const shareHistoryCase = await request('POST', '/api/cases', {
    name: '真实分成历史保护案（赵六）', procedure: '一审', client: '赵六',
  });
  const shareHistoryFee = await request('POST', `/api/cases/${shareHistoryCase.id}/fees`, {
    label: '已有真实分成款', amount: '400.00', due_on: '2026-06-01',
  });
  db.prepare(
    `INSERT INTO fee_shares
       (case_id,fee_item_id,direction,counterpart,amount,amount_fen,due_month,status,entry_kind)
     VALUES (?,?,'payable','孙七',40,4000,'2026-06','pending','manual')`
  ).run(shareHistoryCase.id, shareHistoryFee.id);
  const realShareWaive = await request('PATCH', `/api/fees/${shareHistoryFee.id}`, {
    status: 'waived', version: shareHistoryFee.version,
  }, 409);
  assert.equal(realShareWaive.code, 'settlement_preview_required');
  assert.equal(realShareWaive.settlement_context.share_history, true);
  assert.equal(db.prepare('SELECT status FROM fee_items WHERE id=?').get(shareHistoryFee.id).status, 'unpaid');

  const voidedCase = await request('POST', '/api/cases', {
    name: '作废台账删除保护案（李四）', procedure: '一审', client: '李四',
  });
  const voidedFee = await request('POST', `/api/cases/${voidedCase.id}/fees`, {
    label: '仅有作废分成款', amount: '200.00', due_on: '2026-06-01',
  });
  db.prepare(
    `INSERT INTO fee_shares
       (case_id,fee_item_id,direction,counterpart,amount,amount_fen,due_month,status,entry_kind,
        is_void,voided_at,void_reason)
     VALUES (?,?,'payable','王五',10,1000,'2026-06','pending','manual',1,
             '2026-06-02 00:00:00','删除保护测试')`
  ).run(voidedCase.id, voidedFee.id);
  const voidedDelete = await request('DELETE', `/api/fees/${voidedFee.id}`, undefined, 409);
  assert.equal(voidedDelete.code, 'fee_delete_blocked_by_settlement_context');
  assert.equal(voidedDelete.settlement_context.share_history, false);
  assert.equal(voidedDelete.settlement_context.linked_share, true,
    'voided linked shares must still block physical fee deletion');
  assert(db.prepare('SELECT 1 FROM fee_items WHERE id = ?').get(voidedFee.id));

  // 008：同款 null-agreement legacy 必须阻断 receipt，且所有通用写入口都不能重造同一义务。
  const overlapCase = await request('POST', '/api/cases', {
    name: '同款防重示例案（赵六）', procedure: '一审', client: '赵六',
  });
  const overlapFee = await request('POST', `/api/cases/${overlapCase.id}/fees`, {
    label: '既有已收重叠款', amount: '1000.00',
  });
  await request('PATCH', `/api/fees/${overlapFee.id}`, {
    status: 'paid', paid_on: '2026-06-01',
  });
  const overlapLegacyId = Number(db.prepare(
    `INSERT INTO fee_shares
       (case_id,fee_item_id,direction,counterpart,base_amount,amount,due_month,status,settled_on,entry_kind)
     VALUES (?,?,'payable','孙七',1000,500,'2026-06','settled','2026-06-05','legacy')`
  ).run(overlapCase.id, overlapFee.id).lastInsertRowid);
  const overlapAgreement = await request('POST', `/api/cases/${overlapCase.id}/share-agreements`, {
    direction: 'payable',
    counterpart: '孙七',
    effective_on: '2026-01-01',
    label: '五成初始公式',
    change_note: '同款防重合成回归',
    result_kind: 'rate',
    result_basis: 'gross',
    result_rate_bps: 5000,
    deductions: [],
  });
  await request('PUT', `/api/fees/${overlapFee.id}/share-plans`, {
    agreement_id: overlapAgreement.id,
    status: 'assigned',
    formula_revision_id: overlapAgreement.latest_revision.id,
    revision_choice: 'initial',
    decision_note: '人工纳管既有已收款',
    version: 0,
  });
  const beforeOverlapPreview = writeCounts();
  const overlapPreview = await request('POST', `/api/fees/${overlapFee.id}/settlements/preview`, {
    run_kind: 'receipt', paid_on: '2026-06-01',
  }, 409);
  assert.equal(overlapPreview.code, 'legacy_share_adoption_conflict');
  assert(overlapPreview.shares.some((share) => share.id === overlapLegacyId));
  assert.deepEqual(writeCounts(), beforeOverlapPreview, '重叠 receipt preview 必须零写入');
  const overlapFeeVersion = db.prepare('SELECT version FROM fee_items WHERE id=?').get(overlapFee.id).version;
  const overlapConfirm = await request('POST', `/api/fees/${overlapFee.id}/settlements/confirm`, {
    run_kind: 'receipt',
    paid_on: '2026-06-01',
    fee_version: overlapFeeVersion,
    preview_hash: '0'.repeat(64),
  }, 409);
  assert.equal(overlapConfirm.code, 'legacy_share_adoption_conflict');
  assert.deepEqual(writeCounts(), beforeOverlapPreview, '重叠 receipt confirm 必须在事务内零写入');

  const overlapPost = await request('POST', '/api/shares', {
    case_id: overlapCase.id,
    fee_item_id: overlapFee.id,
    direction: 'payable',
    counterpart: '孙七',
    amount: '1.00',
    due_month: '2026-06',
  }, 409);
  assert.equal(overlapPost.code, 'fee_share_overlap_conflict');

  const identityCandidate = await request('POST', '/api/shares', {
    case_id: overlapCase.id,
    agreement_id: overlapAgreement.id,
    direction: 'payable',
    counterpart: '孙七',
    amount: '4.00',
    due_month: '2026-06',
  });
  const identityMismatch = await request('PATCH', `/api/shares/${identityCandidate.id}`, {
    counterpart: '不是孙七',
  }, 409);
  assert.equal(identityMismatch.code, 'fee_share_overlap_conflict');
  assert.equal(identityMismatch.conflict.kind, 'agreement_identity');
  assert.equal(
    db.prepare('SELECT counterpart FROM fee_shares WHERE id=?').get(identityCandidate.id).counterpart,
    '孙七',
    '显式 agreement 的合作对象不能通过 PATCH 脱钩'
  );

  const patchCandidate = await request('POST', '/api/shares', {
    case_id: overlapCase.id,
    direction: 'payable',
    counterpart: '孙七',
    amount: '2.00',
    due_month: '2026-06',
  });
  const overlapPatch = await request('PATCH', `/api/shares/${patchCandidate.id}`, {
    fee_item_id: overlapFee.id,
  }, 409);
  assert.equal(overlapPatch.code, 'fee_share_overlap_conflict');
  assert.equal(db.prepare('SELECT fee_item_id FROM fee_shares WHERE id=?').get(patchCandidate.id).fee_item_id, null);

  await request('PATCH', `/api/shares/${patchCandidate.id}`, {
    status: 'settled', settled_on: '2026-06-08',
  });
  const hardRepairId = Number(db.prepare(
    `INSERT INTO share_repair_queue (fee_share_id,issue_code)
     VALUES (?,'legacy_settled_unlinked')`
  ).run(patchCandidate.id).lastInsertRowid);
  const hardClaim = await request('POST', `/api/share-repairs/${hardRepairId}/claim`, {
    fee_item_id: overlapFee.id,
    resolution_note: '人工核对仍属同一义务',
    version: 1,
    confirm_independent: true,
    exception_reason: '即使声明独立也不得绕过同款硬冲突',
  }, 409);
  assert.equal(hardClaim.code, 'fee_share_overlap_conflict');
  assert.deepEqual(db.prepare(
    'SELECT status,version FROM share_repair_queue WHERE id=?'
  ).get(hardRepairId), { status: 'open', version: 1 });
  assert.equal(db.prepare('SELECT fee_item_id FROM fee_shares WHERE id=?').get(patchCandidate.id).fee_item_id, null);
  await request('PATCH', `/api/share-agreements/${overlapAgreement.id}`, {
    counterpart: '孙七（更名）',
  });
  const historicalNotePatch = await request('PATCH', `/api/shares/${identityCandidate.id}`, {
    note: 'agreement 更名后仍可维护历史注记',
  });
  assert.equal(historicalNotePatch.note, 'agreement 更名后仍可维护历史注记');

  // 跨款相似仍只是软提示；人工确认独立并说明理由后可认领。
  const softCase = await request('POST', '/api/cases', {
    name: '跨款软提示示例案（李四）', procedure: '一审', client: '李四',
  });
  const softFeeA = await request('POST', `/api/cases/${softCase.id}/fees`, {
    label: '跨款软提示甲', amount: '600.00',
  });
  const softFeeB = await request('POST', `/api/cases/${softCase.id}/fees`, {
    label: '跨款软提示乙', amount: '700.00',
  });
  await request('PATCH', `/api/fees/${softFeeA.id}`, { status: 'paid', paid_on: '2026-06-10' });
  await request('PATCH', `/api/fees/${softFeeB.id}`, { status: 'paid', paid_on: '2026-06-11' });
  await request('POST', '/api/shares', {
    case_id: softCase.id,
    fee_item_id: softFeeA.id,
    direction: 'payable',
    counterpart: '周八',
    amount: '3.21',
    due_month: '2026-06',
  });
  const softSource = await request('POST', '/api/shares', {
    case_id: softCase.id,
    direction: 'payable',
    counterpart: '周八',
    amount: '3.21',
    due_month: '2026-06',
  });
  await request('PATCH', `/api/shares/${softSource.id}`, {
    status: 'settled', settled_on: '2026-06-12',
  });
  const softRepairId = Number(db.prepare(
    `INSERT INTO share_repair_queue (fee_share_id,issue_code)
     VALUES (?,'legacy_settled_unlinked')`
  ).run(softSource.id).lastInsertRowid);
  const softBlocked = await request('POST', `/api/share-repairs/${softRepairId}/claim`, {
    fee_item_id: softFeeB.id,
    resolution_note: '人工核对跨款来源',
    version: 1,
  }, 409);
  assert.equal(softBlocked.code, 'source_claim_conflict');
  assert(softBlocked.soft_duplicates.some((share) => share.fee_item_id === softFeeA.id));
  const softClaimed = await request('POST', `/api/share-repairs/${softRepairId}/claim`, {
    fee_item_id: softFeeB.id,
    resolution_note: '人工确认属于另一笔独立款项',
    version: 1,
    confirm_independent: true,
    exception_reason: '相同金额但来源款不同',
  });
  assert.equal(softClaimed.repair.status, 'claimed');
  assert.equal(softClaimed.repair.share.fee_item_id, softFeeB.id);

  // active agreement 同身份防重：新建与退役后重新激活都必须给出业务级 409。
  const duplicateAgreement = await request('POST', `/api/cases/${shapeCase.id}/share-agreements`, {
    direction: 'payable',
    counterpart: '  周八  ',
    effective_on: '2026-03-01',
    label: '不应新建的重复公式',
    change_note: '应提示追加 revision',
    result_kind: 'rate',
    result_basis: 'gross',
    result_rate_bps: 3000,
    deductions: [],
  }, 409);
  assert.equal(duplicateAgreement.code, 'active_agreement_conflict');
  assert.equal(duplicateAgreement.agreement_id, shapeAgreement.id);

  const retiredFirst = await request('POST', `/api/cases/${overlapCase.id}/share-agreements`, {
    direction: 'payable',
    counterpart: '王五',
    effective_on: '2026-01-01',
    label: '退役后重建甲',
    change_note: '重新激活防重回归',
    result_kind: 'rate',
    result_basis: 'gross',
    result_rate_bps: 1000,
    deductions: [],
  });
  await request('DELETE', `/api/share-agreements/${retiredFirst.id}`);
  const retiredReplacement = await request('POST', `/api/cases/${overlapCase.id}/share-agreements`, {
    direction: 'payable',
    counterpart: '王五',
    effective_on: '2026-02-01',
    label: '退役后重建乙',
    change_note: '保留唯一 active 身份',
    result_kind: 'rate',
    result_basis: 'gross',
    result_rate_bps: 2000,
    deductions: [],
  });
  const reactivateConflict = await request('PATCH', `/api/share-agreements/${retiredFirst.id}`, {
    status: 'active',
  }, 409);
  assert.equal(reactivateConflict.code, 'active_agreement_conflict');
  assert.equal(reactivateConflict.agreement_id, retiredReplacement.id);

  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  console.log('settlement HTTP tests: plan/preview/confirm + zero-delta + retired history + overlap guards + repair semantics + delete guards passed');
} catch (error) {
  let serverLog = '';
  try { serverLog = fs.readFileSync(logPath, 'utf8'); } catch { /* no log */ }
  if (serverLog) console.error(`\n--- settlement test server log ---\n${serverLog}`);
  throw error;
} finally {
  if (db?.open) db.close();
  if (server.exitCode === null) server.kill('SIGTERM');
  fs.closeSync(log);
  fs.rmSync(scratchDir, { recursive: true, force: true });
}
