// 008 升级测试：真实 001–007 fixture → 真实 008。
// 覆盖既有重叠证据保全、同款写入防重、显式 legacy closed 承接、agreement 防重与原子回滚。
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(rootDir, 'src', 'migrations');
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-migration-008-'));
const MIGRATIONS_001_007 = [
  '001_init.sql',
  '002_fees_sessions.sql',
  '003_attachments_legalrag.sql',
  '004_contacts.sql',
  '005_fee_shares.sql',
  '006_share_repairs.sql',
  '007_share_settlement_engine.sql',
];
const MIGRATION_008 = '008_share_ledger_overlap_guards.sql';
const databases = [];
let bootstrap;
let runMigrations;

function copyMigrations(directory, files) {
  fs.mkdirSync(directory);
  for (const file of files) fs.copyFileSync(path.join(migrationsDir, file), path.join(directory, file));
}

function openDatabase(name) {
  const db = new Database(path.join(scratchDir, name));
  db.pragma('foreign_keys = ON');
  databases.push(db);
  return db;
}

function insertCase(db, name) {
  return Number(db.prepare(
    'INSERT INTO cases (name, procedure, stage) VALUES (?, ?, ?)'
  ).run(name, '一审', '待裁判').lastInsertRowid);
}

function insertFee(db, caseId, label) {
  return Number(db.prepare(
    `INSERT INTO fee_items (case_id,label,amount,amount_fen,status,paid_on)
     VALUES (?,?,1000,100000,'paid','2026-01-15')`
  ).run(caseId, label).lastInsertRowid);
}

function insertAgreement(db, caseId, counterpart, direction = 'payable') {
  const agreementId = Number(db.prepare(
    `INSERT INTO fee_share_agreements (case_id,direction,counterpart,rate,status)
     VALUES (?,?,?,?, 'active')`
  ).run(caseId, direction, counterpart, 50).lastInsertRowid);
  const revisionId = Number(db.prepare(
    `INSERT INTO fee_share_formula_revisions
       (agreement_id,case_id,revision_no,effective_on,label,change_note,
        result_kind,result_basis,result_rate_bps,created_by)
     VALUES (?,?,1,'2026-01-01','五成初始公式','008 合成回归',
             'rate','gross',5000,'test-migration-008')`
  ).run(agreementId, caseId).lastInsertRowid);
  db.prepare(
    `UPDATE fee_share_formula_revisions
        SET sealed=1,sealed_at='2026-01-01 00:00:00',sealed_by='test-migration-008'
      WHERE id=?`
  ).run(revisionId);
  return { agreementId, revisionId };
}

function insertAssignment(db, caseId, feeItemId, agreementId, revisionId) {
  return Number(db.prepare(
    `INSERT INTO fee_share_assignments
       (case_id,fee_item_id,agreement_id,status,formula_revision_id,revision_choice,decision_note)
     VALUES (?,?,?,'assigned',?,'initial','人工选择初始公式')`
  ).run(caseId, feeItemId, agreementId, revisionId).lastInsertRowid);
}

function insertRun(db, {
  caseId, feeItemId, kind, sourceRunId = null, requestId = '', previewHash,
  targetStatus = 'paid', paidOn = '2026-01-15', reason = '',
}) {
  return Number(db.prepare(
    `INSERT INTO fee_share_settlement_runs
       (case_id,fee_item_id,run_kind,source_run_id,request_id,preview_hash,
        preview_inputs_json,base_amount_fen,fee_version,target_status,paid_on,reason)
     VALUES (?,?,?,?,?,?,'{}',100000,1,?,?,?)`
  ).run(
    caseId, feeItemId, kind, sourceRunId, requestId, previewHash,
    targetStatus, paidOn, reason
  ).lastInsertRowid);
}

function insertSnapshot(db, {
  runId, caseId, feeItemId, agreementId, revisionId, assignmentId,
  sourceSnapshotId = null, closedFen = 0, newFen = 50000,
  desiredFen = 50000, entryKind = 'calculated', dueMonth = '2026-01',
  revisionChoice = 'initial', counterpart = '李四',
}) {
  return Number(db.prepare(
    `INSERT INTO fee_share_settlement_snapshots
       (settlement_run_id,case_id,fee_item_id,agreement_id,formula_revision_id,
        assignment_id,plan_version,revision_choice,source_snapshot_id,direction,counterpart,
        formula_json,trace_json,base_amount_fen,desired_amount_fen,closed_amount_fen,
        new_amount_fen,entry_kind,due_month)
     VALUES (?,?,?,?,?,?,1,?,?,'payable',?,
             '{"result_kind":"rate","result_basis":"gross","result_rate_bps":5000,"deductions":[]}',
             '[{"step":"result","applied_amount_fen":50000}]',
             100000,?,?,?,?,?)`
  ).run(
    runId, caseId, feeItemId, agreementId, revisionId, assignmentId,
    revisionChoice, sourceSnapshotId, counterpart,
    desiredFen, closedFen, newFen, entryKind, dueMonth
  ).lastInsertRowid);
}

function insertEngineShare(db, {
  caseId, feeItemId, agreementId, assignmentId, snapshotId,
  entryKind = 'calculated', counterpart = '李四', amountFen = 50000, dueMonth = '2026-01',
}) {
  return Number(db.prepare(
    `INSERT INTO fee_shares
       (case_id,agreement_id,fee_item_id,assignment_id,settlement_snapshot_id,entry_kind,
        direction,counterpart,base_amount,base_amount_fen,amount,amount_fen,due_month)
     VALUES (?,?,?,?,?,?,'payable',?,1000,100000,?,?,?)`
  ).run(
    caseId, agreementId, feeItemId, assignmentId, snapshotId,
    entryKind, counterpart, amountFen / 100, amountFen, dueMonth
  ).lastInsertRowid);
}

try {
  process.env.DB_PATH = path.join(scratchDir, 'bootstrap.db');
  ({ db: bootstrap, runMigrations } = await import('../src/db.js'));
  bootstrap.close();

  const v7Dir = path.join(scratchDir, 'migrations-007');
  const v8Dir = path.join(scratchDir, 'migrations-008');
  copyMigrations(v7Dir, MIGRATIONS_001_007);
  copyMigrations(v8Dir, [...MIGRATIONS_001_007, MIGRATION_008]);

  const fixture = openDatabase('from-007.db');
  runMigrations(fixture, v7Dir);
  assert.equal(fixture.pragma('user_version', { simple: true }), 7, 'fixture 必须停在真实 007');

  const caseId = insertCase(fixture, '同款防重示例案（张三）');
  const feeId = insertFee(fixture, caseId, '既有重叠示例款');
  const blockedFeeId = insertFee(fixture, caseId, '数据库兜底示例款');
  const normalFeeId = insertFee(fixture, caseId, '正常引擎示例款');
  const primary = insertAgreement(fixture, caseId, '李四');
  const independent = insertAgreement(fixture, caseId, '王五');

  const assignmentId = insertAssignment(
    fixture, caseId, feeId, primary.agreementId, primary.revisionId
  );
  const blockedAssignmentId = insertAssignment(
    fixture, caseId, blockedFeeId, primary.agreementId, primary.revisionId
  );
  const normalAssignmentId = insertAssignment(
    fixture, caseId, normalFeeId, primary.agreementId, primary.revisionId
  );

  // 007 允许留下重复 active agreement。008 不改写它们，但必须阻止继续结算；
  // 已有链的 reversal 仍须能按 source snapshot 正常冲销。
  const duplicateCaseId = insertCase(fixture, '重复约定保全示例案（钱九）');
  const duplicateBlockedFeeId = insertFee(fixture, duplicateCaseId, '重复约定阻断款');
  const duplicateReversalFeeId = insertFee(fixture, duplicateCaseId, '重复约定历史冲销款');
  const duplicatePrimary = insertAgreement(fixture, duplicateCaseId, '钱九');
  const duplicateSibling = insertAgreement(fixture, duplicateCaseId, '  钱九  ');
  const duplicateBlockedAssignmentId = insertAssignment(
    fixture, duplicateCaseId, duplicateBlockedFeeId,
    duplicatePrimary.agreementId, duplicatePrimary.revisionId
  );
  const duplicateReversalAssignmentId = insertAssignment(
    fixture, duplicateCaseId, duplicateReversalFeeId,
    duplicatePrimary.agreementId, duplicatePrimary.revisionId
  );
  const duplicateReceiptRunId = insertRun(fixture, {
    caseId: duplicateCaseId,
    feeItemId: duplicateReversalFeeId,
    kind: 'receipt',
    previewHash: '008-duplicate-existing-receipt',
  });
  const duplicateReceiptSnapshotId = insertSnapshot(fixture, {
    runId: duplicateReceiptRunId,
    caseId: duplicateCaseId,
    feeItemId: duplicateReversalFeeId,
    agreementId: duplicatePrimary.agreementId,
    revisionId: duplicatePrimary.revisionId,
    assignmentId: duplicateReversalAssignmentId,
    counterpart: '钱九',
  });
  const duplicateReceiptShareId = insertEngineShare(fixture, {
    caseId: duplicateCaseId,
    feeItemId: duplicateReversalFeeId,
    agreementId: duplicatePrimary.agreementId,
    assignmentId: duplicateReversalAssignmentId,
    snapshotId: duplicateReceiptSnapshotId,
    counterpart: '钱九',
  });
  fixture.prepare(
    "UPDATE fee_shares SET status='settled',settled_on='2026-01-20' WHERE id=?"
  ).run(duplicateReceiptShareId);

  // v7 可留下的真实缺陷形状：同款同对象 null-agreement legacy + engine pending 并存。
  const legacyId = Number(fixture.prepare(
    `INSERT INTO fee_shares
       (case_id,fee_item_id,direction,counterpart,base_amount,amount,due_month,status,settled_on,entry_kind)
     VALUES (?,?,'payable','李四',1000,500,'2026-01','settled','2026-01-20','legacy')`
  ).run(caseId, feeId).lastInsertRowid);
  const receiptRunId = insertRun(fixture, {
    caseId, feeItemId: feeId, kind: 'receipt', previewHash: '008-existing-receipt',
  });
  const receiptSnapshotId = insertSnapshot(fixture, {
    runId: receiptRunId, caseId, feeItemId: feeId,
    agreementId: primary.agreementId, revisionId: primary.revisionId,
    assignmentId,
  });
  const pendingEngineId = insertEngineShare(fixture, {
    caseId, feeItemId: feeId, agreementId: primary.agreementId,
    assignmentId, snapshotId: receiptSnapshotId,
  });

  // 第二个 v7 缺陷样例只先建 snapshot，供 v8 engine INSERT 触发器兜底测试。
  const blockedLegacyId = Number(fixture.prepare(
    `INSERT INTO fee_shares
       (case_id,fee_item_id,direction,counterpart,amount,due_month,status,settled_on,entry_kind)
     VALUES (?,?,'payable','李四',500,'2026-01','settled','2026-01-20','legacy')`
  ).run(caseId, blockedFeeId).lastInsertRowid);
  const blockedRunId = insertRun(fixture, {
    caseId, feeItemId: blockedFeeId, kind: 'receipt', previewHash: '008-blocked-receipt',
  });
  const blockedSnapshotId = insertSnapshot(fixture, {
    runId: blockedRunId, caseId, feeItemId: blockedFeeId,
    agreementId: primary.agreementId, revisionId: primary.revisionId,
    assignmentId: blockedAssignmentId,
  });

  const normalRunId = insertRun(fixture, {
    caseId, feeItemId: normalFeeId, kind: 'receipt', previewHash: '008-normal-receipt',
  });
  const normalSnapshotId = insertSnapshot(fixture, {
    runId: normalRunId, caseId, feeItemId: normalFeeId,
    agreementId: primary.agreementId, revisionId: primary.revisionId,
    assignmentId: normalAssignmentId,
  });

  const evidenceBefore = fixture.prepare(
    `SELECT id,agreement_id,fee_item_id,status,amount_fen,is_void,cancelled_at
       FROM fee_shares ORDER BY id`
  ).all();
  runMigrations(fixture, v8Dir);
  assert.equal(fixture.pragma('user_version', { simple: true }), 8, '升级后 user_version 应为 8');
  assert.deepEqual(fixture.prepare(
    `SELECT id,agreement_id,fee_item_id,status,amount_fen,is_void,cancelled_at
       FROM fee_shares ORDER BY id`
  ).all(), evidenceBefore, '008 不得自动改写、作废或删除既有重叠证据');
  assert.deepEqual(
    fixture.prepare('SELECT id FROM fee_shares WHERE id IN (?,?,?) ORDER BY id').all(
      legacyId, pendingEngineId, blockedLegacyId
    ).map((row) => row.id),
    [legacyId, pendingEngineId, blockedLegacyId].sort((a, b) => a - b)
  );
  assert.deepEqual(
    fixture.prepare(
      `SELECT id FROM fee_share_agreements
        WHERE case_id=? AND status='active' AND direction='payable'
          AND trim(counterpart)='钱九' ORDER BY id`
    ).all(duplicateCaseId).map((row) => row.id),
    [duplicatePrimary.agreementId, duplicateSibling.agreementId],
    '008 不得自动退役或合并既有重复 active agreement'
  );

  const duplicateBlockedRunId = insertRun(fixture, {
    caseId: duplicateCaseId,
    feeItemId: duplicateBlockedFeeId,
    kind: 'receipt',
    previewHash: '008-duplicate-blocked-receipt',
  });
  assert.throws(() => insertSnapshot(fixture, {
    runId: duplicateBlockedRunId,
    caseId: duplicateCaseId,
    feeItemId: duplicateBlockedFeeId,
    agreementId: duplicatePrimary.agreementId,
    revisionId: duplicatePrimary.revisionId,
    assignmentId: duplicateBlockedAssignmentId,
    counterpart: '钱九',
  }), /duplicate active fee share agreement identity/);

  const duplicateReversalRunId = insertRun(fixture, {
    caseId: duplicateCaseId,
    feeItemId: duplicateReversalFeeId,
    kind: 'reversal',
    sourceRunId: duplicateReceiptRunId,
    requestId: '008-duplicate-reversal-1',
    previewHash: '008-duplicate-reversal-preview-1',
    targetStatus: 'unpaid',
    paidOn: '',
    reason: '重复约定清理前先允许冲销既有历史',
  });
  const duplicateReversalSnapshotId = insertSnapshot(fixture, {
    runId: duplicateReversalRunId,
    caseId: duplicateCaseId,
    feeItemId: duplicateReversalFeeId,
    agreementId: duplicatePrimary.agreementId,
    revisionId: duplicatePrimary.revisionId,
    assignmentId: duplicateReversalAssignmentId,
    sourceSnapshotId: duplicateReceiptSnapshotId,
    desiredFen: 0,
    closedFen: 50000,
    newFen: -50000,
    entryKind: 'adjustment',
    revisionChoice: 'source',
    counterpart: '钱九',
  });
  const duplicateReversalShareId = insertEngineShare(fixture, {
    caseId: duplicateCaseId,
    feeItemId: duplicateReversalFeeId,
    agreementId: duplicatePrimary.agreementId,
    assignmentId: duplicateReversalAssignmentId,
    snapshotId: duplicateReversalSnapshotId,
    entryKind: 'adjustment',
    counterpart: '钱九',
    amountFen: -50000,
  });
  assert.ok(duplicateReversalShareId, 'reversal 不得被当前重复 active agreement 错误阻断');

  // 同案、同方向、trim 后同对象只能保留一个 active agreement；不同方向不误拦。
  assert.throws(() => fixture.prepare(
    `INSERT INTO fee_share_agreements (case_id,direction,counterpart,rate,status)
     VALUES (?,'payable','  李四  ',25,'active')`
  ).run(caseId), /active fee share agreement identity already exists/);
  const receivableAgreement = fixture.prepare(
    `INSERT INTO fee_share_agreements (case_id,direction,counterpart,rate,status)
     VALUES (?,'receivable','李四',25,'active')`
  ).run(caseId).lastInsertRowid;
  assert.ok(receivableAgreement, '不同方向的 active agreement 不应被误拦');

  // legacy/manual 不能从 INSERT、普通 UPDATE 或错误 agreement 显式挂接绕过同款保护。
  assert.throws(() => fixture.prepare(
    `INSERT INTO fee_shares
       (case_id,fee_item_id,direction,counterpart,amount,due_month,entry_kind)
     VALUES (?,?,'payable','李四',1,'2026-01','manual')`
  ).run(caseId, feeId), /fee share overlaps managed obligation/);
  assert.throws(() => fixture.prepare(
    `INSERT INTO fee_shares
       (case_id,agreement_id,fee_item_id,direction,counterpart,amount,due_month,entry_kind)
     VALUES (?,?,?,'payable','不是王五',1,'2026-01','manual')`
  ).run(caseId, independent.agreementId, feeId), /fee share overlaps managed obligation/);
  assert.throws(() => fixture.prepare(
    'UPDATE fee_shares SET agreement_id=? WHERE id=?'
  ).run(independent.agreementId, legacyId), /fee share overlaps managed obligation/);

  // 受控修复只允许在 fee/方向/对象不变且 agreement 身份精确匹配时显式挂接。
  fixture.prepare('UPDATE fee_shares SET agreement_id=? WHERE id=?')
    .run(primary.agreementId, legacyId);
  assert.equal(
    fixture.prepare('SELECT agreement_id FROM fee_shares WHERE id=?').get(legacyId).agreement_id,
    primary.agreementId
  );

  // correction 的 closed 必须承接显式同 agreement 的 settled legacy；null-agreement 不会静默认领。
  const correctionRunId = insertRun(fixture, {
    caseId,
    feeItemId: feeId,
    kind: 'correction',
    sourceRunId: receiptRunId,
    requestId: '008-correction-1',
    previewHash: '008-correction-preview-1',
    paidOn: '2026-02-01',
    reason: '显式承接历史已结事实',
  });
  assert.throws(() => insertSnapshot(fixture, {
    runId: correctionRunId, caseId, feeItemId: feeId,
    agreementId: primary.agreementId, revisionId: primary.revisionId,
    assignmentId, sourceSnapshotId: receiptSnapshotId,
    closedFen: 0, newFen: 50000, entryKind: 'adjustment', dueMonth: '2026-02',
  }), /closed_amount_fen/);
  const correctionSnapshotId = insertSnapshot(fixture, {
    runId: correctionRunId, caseId, feeItemId: feeId,
    agreementId: primary.agreementId, revisionId: primary.revisionId,
    assignmentId, sourceSnapshotId: receiptSnapshotId,
    closedFen: 50000, newFen: 0, entryKind: 'adjustment', dueMonth: '2026-02',
  });
  assert.equal(
    fixture.prepare('SELECT closed_amount_fen FROM fee_share_settlement_snapshots WHERE id=?')
      .get(correctionSnapshotId).closed_amount_fen,
    50000
  );

  // 即使应用层漏检，receipt engine INSERT 仍不能跨过 null-agreement legacy。
  assert.throws(() => insertEngineShare(fixture, {
    caseId, feeItemId: blockedFeeId, agreementId: primary.agreementId,
    assignmentId: blockedAssignmentId, snapshotId: blockedSnapshotId,
  }), /engine share overlaps legacy\/manual obligation/);
  const normalEngineId = insertEngineShare(fixture, {
    caseId, feeItemId: normalFeeId, agreementId: primary.agreementId,
    assignmentId: normalAssignmentId, snapshotId: normalSnapshotId,
  });
  assert.ok(normalEngineId, '无重叠的正常 engine 写入必须继续成功');

  // 明确不同 agreement 的同款人工义务不误拦；作废后也不继续占活动重叠位。
  const independentShareId = Number(fixture.prepare(
    `INSERT INTO fee_shares
       (case_id,agreement_id,fee_item_id,direction,counterpart,amount,due_month,entry_kind)
     VALUES (?,?,?,'payable','王五',100,'2026-01','manual')`
  ).run(caseId, independent.agreementId, feeId).lastInsertRowid);
  fixture.prepare(
    `UPDATE fee_shares
        SET is_void=1,voided_at='2026-02-02',void_reason='合成回归作废'
      WHERE id=?`
  ).run(independentShareId);
  const replacementIndependent = fixture.prepare(
    `INSERT INTO fee_shares
       (case_id,agreement_id,fee_item_id,direction,counterpart,amount,due_month,entry_kind)
     VALUES (?,?,?,'payable','王五',100,'2026-01','manual')`
  ).run(caseId, independent.agreementId, feeId).lastInsertRowid;
  assert.ok(replacementIndependent, '作废行不应阻断明确不同义务的后续正常写入');

  assert.equal(fixture.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(fixture.pragma('foreign_key_check'), []);

  // 真实 008 末尾附加故障：索引、触发器与 user_version 必须一起回滚。
  const failureDir = path.join(scratchDir, 'migrations-008-failure');
  copyMigrations(failureDir, MIGRATIONS_001_007);
  fs.writeFileSync(
    path.join(failureDir, MIGRATION_008),
    `${fs.readFileSync(path.join(migrationsDir, MIGRATION_008), 'utf8')}\nTHIS IS INVALID SQL;\n`
  );
  const failing = openDatabase('atomic-008.db');
  runMigrations(failing, v7Dir);
  const failingCase = insertCase(failing, '原子回滚示例案（李四）');
  assert.throws(() => runMigrations(failing, failureDir), /near "THIS"|syntax error/i);
  assert.equal(failing.pragma('user_version', { simple: true }), 7);
  assert.equal(
    failing.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_share_overlap_fee_identity'").get(),
    undefined
  );
  assert.equal(
    failing.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_share_engine_legacy_overlap_insert'").get(),
    undefined
  );
  assert.equal(
    failing.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_share_snapshot_active_identity_insert'").get(),
    undefined
  );
  assert.equal(failing.prepare('SELECT COUNT(*) AS count FROM cases WHERE id=?').get(failingCase).count, 1);
  assert.deepEqual(failing.pragma('foreign_key_check'), []);

  console.log('migration 008 tests: evidence preservation + overlap/duplicate-active guards + reversal escape + atomic rollback passed');
} finally {
  for (const db of databases) {
    if (db.open) db.close();
  }
  if (bootstrap?.open) bootstrap.close();
  fs.rmSync(scratchDir, { recursive: true, force: true });
}
