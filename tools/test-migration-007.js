// 007 升级测试：真实 001–006 fixture → 真实 007。
// 覆盖 legacy 保全、canonical money、封存 revision、assignment、run/snapshot lineage、engine ledger 与原子回滚。
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(rootDir, 'src', 'migrations');
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-migration-007-'));
const MIGRATIONS_001_006 = [
  '001_init.sql',
  '002_fees_sessions.sql',
  '003_attachments_legalrag.sql',
  '004_contacts.sql',
  '005_fee_shares.sql',
  '006_share_repairs.sql',
];
const MIGRATION_007 = '007_share_settlement_engine.sql';
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

function insertFee(db, caseId, label, amount = null, status = 'unpaid', paidOn = '') {
  return Number(db.prepare(
    'INSERT INTO fee_items (case_id, label, amount, status, paid_on) VALUES (?, ?, ?, ?, ?)'
  ).run(caseId, label, amount, status, paidOn).lastInsertRowid);
}

function insertAssignment(db, {
  caseId, feeItemId, agreementId, status = 'assigned', formulaRevisionId = null,
  revisionChoice = status === 'assigned' ? 'initial' : 'not_applicable', decisionNote = '',
}) {
  return Number(db.prepare(
    `INSERT INTO fee_share_assignments
       (case_id,fee_item_id,agreement_id,status,formula_revision_id,revision_choice,decision_note)
     VALUES (?,?,?,?,?,?,?)`
  ).run(
    caseId, feeItemId, agreementId, status, formulaRevisionId, revisionChoice, decisionNote
  ).lastInsertRowid);
}

function insertRun(db, {
  caseId, feeItemId, kind, sourceRunId = null, requestId = '', previewHash,
  baseFen, feeVersion, targetStatus, paidOn = '', reason = '',
}) {
  return Number(db.prepare(
    `INSERT INTO fee_share_settlement_runs
       (case_id,fee_item_id,run_kind,source_run_id,request_id,preview_hash,
        preview_inputs_json,base_amount_fen,fee_version,target_status,paid_on,reason)
     VALUES (?,?,?,?,?,?,'{}',?,?,?,?,?)`
  ).run(
    caseId, feeItemId, kind, sourceRunId, requestId, previewHash,
    baseFen, feeVersion, targetStatus, paidOn, reason
  ).lastInsertRowid);
}

function insertSnapshot(db, {
  runId, caseId, feeItemId, agreementId, revisionId, assignmentId, planVersion,
  revisionChoice, sourceSnapshotId = null, counterpart, formulaJson, traceJson,
  baseFen, desiredFen, closedFen, newFen, entryKind, dueMonth,
}) {
  return Number(db.prepare(
    `INSERT INTO fee_share_settlement_snapshots
       (settlement_run_id,case_id,fee_item_id,agreement_id,formula_revision_id,
        assignment_id,plan_version,revision_choice,source_snapshot_id,direction,counterpart,
        formula_json,trace_json,base_amount_fen,desired_amount_fen,closed_amount_fen,
        new_amount_fen,entry_kind,due_month)
     VALUES (?,?,?,?,?,?,?,?,?,'payable',?,?,?,?,?,?,?,?,?)`
  ).run(
    runId, caseId, feeItemId, agreementId, revisionId,
    assignmentId, planVersion, revisionChoice, sourceSnapshotId, counterpart,
    formulaJson, traceJson, baseFen, desiredFen, closedFen, newFen, entryKind, dueMonth
  ).lastInsertRowid);
}

function insertEngineShare(db, {
  caseId, agreementId, feeItemId, assignmentId, snapshotId, entryKind,
  counterpart, baseFen, amountFen, dueMonth, note = '',
}) {
  return Number(db.prepare(
    `INSERT INTO fee_shares
       (case_id,agreement_id,fee_item_id,assignment_id,settlement_snapshot_id,entry_kind,
        direction,counterpart,base_amount,base_amount_fen,amount,amount_fen,due_month,note)
     VALUES (?,?,?,?,?,?,'payable',?,?,?,?,?,?,?)`
  ).run(
    caseId, agreementId, feeItemId, assignmentId, snapshotId, entryKind,
    counterpart, baseFen === null ? null : Number(baseFen) / 100, baseFen,
    Number(amountFen) / 100, amountFen, dueMonth, note
  ).lastInsertRowid);
}

try {
  process.env.DB_PATH = path.join(scratchDir, 'bootstrap.db');
  ({ db: bootstrap, runMigrations } = await import('../src/db.js'));
  bootstrap.close();

  const legacyDir = path.join(scratchDir, 'migrations-006');
  const upgradeDir = path.join(scratchDir, 'migrations-007');
  copyMigrations(legacyDir, MIGRATIONS_001_006);
  copyMigrations(upgradeDir, [...MIGRATIONS_001_006, MIGRATION_007]);

  const fixture = openDatabase('from-006.db');
  runMigrations(fixture, legacyDir);
  assert.equal(fixture.pragma('user_version', { simple: true }), 6, 'fixture 必须停在真实 006');

  const caseOne = insertCase(fixture, '示例结算案（张三）');
  const caseTwo = insertCase(fixture, '示例结算案（李四）');
  const feeOne = insertFee(fixture, caseOne, '已收示例款', 1234.56, 'paid', '2026-07-15');
  fixture.prepare("UPDATE fee_items SET note = '保留款项备注' WHERE id = ?").run(feeOne);
  const feeTwo = insertFee(fixture, caseTwo, '跨案示例款', 800);

  const rateAgreement = Number(fixture.prepare(
    `INSERT INTO fee_share_agreements
       (case_id, direction, counterpart, rate, note, created_at)
     VALUES (?, 'payable', '王五', 33.33, '比例约定原备注', '2026-07-01 09:00:00')`
  ).run(caseOne).lastInsertRowid);
  const flatAgreement = Number(fixture.prepare(
    `INSERT INTO fee_share_agreements
       (case_id, direction, counterpart, flat_amount, note, created_at)
     VALUES (?, 'payable', '赵六', 200.25, '固定约定原备注', '2026-07-02 09:00:00')`
  ).run(caseOne).lastInsertRowid);
  const otherAgreement = Number(fixture.prepare(
    `INSERT INTO fee_share_agreements
       (case_id, direction, counterpart, rate, created_at)
     VALUES (?, 'payable', '孙七', 20, '2026-07-03 09:00:00')`
  ).run(caseTwo).lastInsertRowid);

  const insertShare = fixture.prepare(
    `INSERT INTO fee_shares
       (case_id, external_case, agreement_id, fee_item_id, direction, counterpart,
        base_amount, amount, due_month, status, settled_on, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const rateShare = Number(insertShare.run(
    caseOne, '', rateAgreement, feeOne, 'payable', '王五', 1234.56, 411.48,
    '2026-07', 'pending', '', '比例台账原备注'
  ).lastInsertRowid);
  const fixedShare = Number(insertShare.run(
    caseOne, '', flatAgreement, null, 'payable', '赵六', null, 200.25,
    '2026-07', 'settled', '2026-07-15', '固定台账原备注'
  ).lastInsertRowid);
  const repairShare = Number(insertShare.run(
    caseOne, '', null, null, 'payable', '周八', null, -30.01,
    '2026-06', 'settled', '2026-07-01', '006 修复原备注'
  ).lastInsertRowid);
  const repairId = Number(fixture.prepare(
    `INSERT INTO share_repair_queue
       (fee_share_id, issue_code, status, proposed_fee_item_id, resolution_note,
        exception_reason, resolved_at, version)
     VALUES (?, 'legacy_settled_unlinked', 'retained_unlinked', NULL,
             '人工保留原说明', '原例外说明', '2026-07-15 10:00:00', 3)`
  ).run(repairShare).lastInsertRowid);

  const shareBusinessBefore = fixture.prepare(
    `SELECT id, case_id, external_case, agreement_id, fee_item_id, direction, counterpart,
            base_amount, amount, due_month, status, settled_on, note,
            is_void, voided_at, void_reason
       FROM fee_shares ORDER BY id`
  ).all();
  const repairBefore = fixture.prepare(
    `SELECT id, fee_share_id, issue_code, status, proposed_fee_item_id, resolution_note,
            exception_reason, created_at, resolved_at, version
       FROM share_repair_queue WHERE id = ?`
  ).get(repairId);
  const shareCountBefore = fixture.prepare('SELECT COUNT(*) AS count FROM fee_shares').get().count;

  runMigrations(fixture, upgradeDir);
  assert.equal(fixture.pragma('user_version', { simple: true }), 7, '升级后 user_version 应为 7');

  // DESIGN.md 与 schema 使用同一组 canonical 表名；旧草案名不得残留。
  for (const table of [
    'fee_share_formula_revisions',
    'fee_share_formula_deductions',
    'fee_share_assignments',
    'fee_share_settlement_runs',
    'fee_share_settlement_snapshots',
  ]) {
    assert.ok(fixture.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), `${table} 必须存在`);
  }
  for (const staleName of [
    'fee_share_agreement_revisions',
    'fee_share_plan_assignments',
    'fee_share_calculation_snapshots',
  ]) {
    assert.equal(fixture.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(staleName), undefined, `${staleName} 不得存在`);
  }

  // 005 agreement 等价回填 revision 1：sealed + effective/label/change_note/rounding 明确。
  assert.deepEqual(fixture.prepare(
    `SELECT agreement_id, case_id, revision_no, effective_on, label, change_note,
            rounding_mode, result_kind, result_basis, result_rate_bps, result_fixed_fen,
            sealed, sealed_by, created_by
       FROM fee_share_formula_revisions ORDER BY agreement_id`
  ).all(), [
    {
      agreement_id: rateAgreement, case_id: caseOne, revision_no: 1,
      effective_on: '2026-07-01', label: 'Legacy formula (005)',
      change_note: 'Backfilled from fee_share_agreements without recalculation',
      rounding_mode: 'toward_zero', result_kind: 'rate', result_basis: 'gross',
      result_rate_bps: 3333, result_fixed_fen: null, sealed: 1,
      sealed_by: 'migration-007', created_by: 'migration-007',
    },
    {
      agreement_id: flatAgreement, case_id: caseOne, revision_no: 1,
      effective_on: '2026-07-02', label: 'Legacy formula (005)',
      change_note: 'Backfilled from fee_share_agreements without recalculation',
      rounding_mode: 'toward_zero', result_kind: 'fixed', result_basis: null,
      result_rate_bps: null, result_fixed_fen: 20025, sealed: 1,
      sealed_by: 'migration-007', created_by: 'migration-007',
    },
    {
      agreement_id: otherAgreement, case_id: caseTwo, revision_no: 1,
      effective_on: '2026-07-03', label: 'Legacy formula (005)',
      change_note: 'Backfilled from fee_share_agreements without recalculation',
      rounding_mode: 'toward_zero', result_kind: 'rate', result_basis: 'gross',
      result_rate_bps: 2000, result_fixed_fen: null, sealed: 1,
      sealed_by: 'migration-007', created_by: 'migration-007',
    },
  ]);
  assert.equal(fixture.prepare('SELECT COUNT(*) AS count FROM fee_share_formula_deductions').get().count, 0, 'legacy revision 不补 deduction');
  assert.equal(fixture.prepare('SELECT COUNT(*) AS count FROM fee_share_assignments').get().count, 0, 'migration 不补 assignment');
  assert.equal(fixture.prepare('SELECT COUNT(*) AS count FROM fee_share_settlement_runs').get().count, 0, 'migration 不补 run');
  assert.equal(fixture.prepare('SELECT COUNT(*) AS count FROM fee_share_settlement_snapshots').get().count, 0, 'migration 不补 snapshot');
  assert.equal(fixture.prepare('SELECT COUNT(*) AS count FROM fee_shares').get().count, shareCountBefore, 'migration 不补 share');

  // 005/006 业务字段和修复队列逐字段保持；只新增 canonical fen/entry_kind。
  assert.deepEqual(fixture.prepare(
    `SELECT id, case_id, external_case, agreement_id, fee_item_id, direction, counterpart,
            base_amount, amount, due_month, status, settled_on, note,
            is_void, voided_at, void_reason
       FROM fee_shares ORDER BY id`
  ).all(), shareBusinessBefore);
  assert.deepEqual(fixture.prepare(
    `SELECT id, fee_share_id, issue_code, status, proposed_fee_item_id, resolution_note,
            exception_reason, created_at, resolved_at, version
       FROM share_repair_queue WHERE id = ?`
  ).get(repairId), repairBefore);
  assert.deepEqual(fixture.prepare(
    'SELECT id, amount_fen, base_amount_fen, entry_kind, cancelled_by_run_id FROM fee_shares ORDER BY id'
  ).all(), [
    { id: rateShare, amount_fen: 41148, base_amount_fen: 123456, entry_kind: 'legacy', cancelled_by_run_id: null },
    { id: fixedShare, amount_fen: 20025, base_amount_fen: null, entry_kind: 'legacy', cancelled_by_run_id: null },
    { id: repairShare, amount_fen: -3001, base_amount_fen: null, entry_kind: 'legacy', cancelled_by_run_id: null },
  ]);
  assert.deepEqual(fixture.prepare('SELECT id, amount_fen, version FROM fee_items ORDER BY id').all(), [
    { id: feeOne, amount_fen: 123456, version: 1 },
    { id: feeTwo, amount_fen: 80000, version: 1 },
  ]);

  // canonical fee money：旧写法省略 fen 时派生；NULL REAL 清 fen；显式 fen 匹配才保留。
  const derivedFee = insertFee(fixture, caseOne, 'canonical 派生', 12.34);
  assert.equal(fixture.prepare('SELECT amount_fen FROM fee_items WHERE id=?').get(derivedFee).amount_fen, 1234);
  fixture.prepare('UPDATE fee_items SET amount=? WHERE id=?').run(23.45, derivedFee);
  assert.equal(fixture.prepare('SELECT amount_fen FROM fee_items WHERE id=?').get(derivedFee).amount_fen, 2345);
  fixture.prepare('UPDATE fee_items SET amount=NULL WHERE id=?').run(derivedFee);
  assert.deepEqual(fixture.prepare('SELECT amount, amount_fen FROM fee_items WHERE id=?').get(derivedFee), { amount: null, amount_fen: null });
  fixture.prepare('UPDATE fee_items SET amount=?, amount_fen=? WHERE id=?').run(9.99, 999, derivedFee);
  assert.equal(fixture.prepare('SELECT amount_fen FROM fee_items WHERE id=?').get(derivedFee).amount_fen, 999);
  fixture.prepare('UPDATE fee_items SET amount_fen=NULL WHERE id=?').run(derivedFee);
  assert.equal(fixture.prepare('SELECT amount_fen FROM fee_items WHERE id=?').get(derivedFee).amount_fen, 999, '非空 REAL 下 canonical NULL 自动修复');
  assert.throws(() => fixture.prepare('UPDATE fee_items SET amount=?, amount_fen=? WHERE id=?').run(10, 998, derivedFee), /match amount_fen/);
  assert.throws(() => fixture.prepare('UPDATE fee_items SET amount=? WHERE id=?').run(1.001, derivedFee), /cent-exact/);
  assert.throws(() => fixture.prepare('INSERT INTO fee_items (case_id,label,amount) VALUES (?,?,?)').run(caseOne, 'sub-cent', 1.001), /cent-exact/);
  const maxSafeFee = Number(fixture.prepare(
    'INSERT INTO fee_items (case_id,label,amount,amount_fen) VALUES (?,?,?,?)'
  ).run(caseOne, 'safe max', 90071992547409.91, Number.MAX_SAFE_INTEGER).lastInsertRowid);
  assert.equal(fixture.prepare('SELECT amount_fen FROM fee_items WHERE id=?').get(maxSafeFee).amount_fen, Number.MAX_SAFE_INTEGER);
  assert.throws(() => fixture.prepare(
    'INSERT INTO fee_items (case_id,label,amount,amount_fen) VALUES (?,?,?,?)'
  ).run(caseOne, 'unsafe fen', 1, Number.MAX_SAFE_INTEGER + 1), /cent-exact|CHECK constraint/);

  // canonical manual share money：amount/base 分别派生，NULL base 清 fen，矛盾或 sub-cent 拒绝。
  const manualShare = Number(fixture.prepare(
    `INSERT INTO fee_shares
       (case_id, direction, counterpart, base_amount, amount, due_month)
     VALUES (?, 'payable', '人工甲', 10.01, 3.33, '2026-07')`
  ).run(caseOne).lastInsertRowid);
  assert.deepEqual(fixture.prepare(
    'SELECT amount_fen, base_amount_fen, entry_kind FROM fee_shares WHERE id=?'
  ).get(manualShare), { amount_fen: 333, base_amount_fen: 1001, entry_kind: 'manual' });
  fixture.prepare('UPDATE fee_shares SET amount=?, base_amount=NULL WHERE id=?').run(4.44, manualShare);
  assert.deepEqual(fixture.prepare(
    'SELECT amount_fen, base_amount_fen FROM fee_shares WHERE id=?'
  ).get(manualShare), { amount_fen: 444, base_amount_fen: null });
  fixture.prepare('UPDATE fee_shares SET amount_fen=NULL WHERE id=?').run(manualShare);
  assert.equal(fixture.prepare('SELECT amount_fen FROM fee_shares WHERE id=?').get(manualShare).amount_fen, 444);
  assert.throws(() => fixture.prepare(
    `INSERT INTO fee_shares
       (case_id, direction, counterpart, amount, amount_fen, due_month)
     VALUES (?, 'payable', '矛盾甲', 5.55, 556, '2026-07')`
  ).run(caseOne), /deterministic engine fen projection/);
  assert.throws(() => fixture.prepare(
    `INSERT INTO fee_shares
       (case_id, direction, counterpart, amount, due_month)
     VALUES (?, 'payable', '小数甲', 1.001, '2026-07')`
  ).run(caseOne), /cent-exact/);

  // agreement status 词表固定 active|retired。
  assert.throws(() => fixture.prepare("UPDATE fee_share_agreements SET status='paused' WHERE id=?").run(otherAgreement), /CHECK constraint/);

  const rateRevision1 = fixture.prepare(
    'SELECT id FROM fee_share_formula_revisions WHERE agreement_id=? AND revision_no=1'
  ).get(rateAgreement).id;
  const flatRevision1 = fixture.prepare(
    'SELECT id FROM fee_share_formula_revisions WHERE agreement_id=? AND revision_no=1'
  ).get(flatAgreement).id;
  const otherRevision1 = fixture.prepare(
    'SELECT id FROM fee_share_formula_revisions WHERE agreement_id=? AND revision_no=1'
  ).get(otherAgreement).id;

  // revision 必须 unsealed 插入，只有一次 seal 更新；deduction 在封存前可整理，封存时查 1..N。
  assert.throws(() => fixture.prepare(
    `INSERT INTO fee_share_formula_revisions
       (agreement_id,case_id,revision_no,effective_on,label,change_note,
        result_kind,result_basis,result_rate_bps,sealed,sealed_at,sealed_by)
     VALUES (?,?,2,'2026-07-10','直封','不允许直封','rate','gross',5000,1,'2026-07-10','fang')`
  ).run(rateAgreement, caseOne), /inserted unsealed/);
  const rateRevision2 = Number(fixture.prepare(
    `INSERT INTO fee_share_formula_revisions
       (agreement_id,case_id,revision_no,effective_on,label,change_note,
        result_kind,result_basis,result_rate_bps)
     VALUES (?,?,2,'2026-07-10','扣减后五成','增加有序扣减','rate','remaining',5000)`
  ).run(rateAgreement, caseOne).lastInsertRowid);
  assert.throws(() => fixture.prepare("UPDATE fee_share_formula_revisions SET label='改名' WHERE id=?").run(rateRevision2), /except one-way sealing/);
  assert.throws(() => fixture.prepare(
    `INSERT INTO fee_share_formula_revisions
       (agreement_id,case_id,revision_no,effective_on,label,change_note,
        result_kind,result_basis,result_rate_bps)
     VALUES (?,?,4,'2026-07-10','跳号','不允许跳号','rate','gross',5000)`
  ).run(rateAgreement, caseOne), /revision_no must be contiguous/);
  assert.throws(() => fixture.prepare(
    `INSERT INTO fee_share_formula_revisions
       (agreement_id,case_id,revision_no,effective_on,label,change_note,
        result_kind,result_rate_bps)
     VALUES (?,?,3,'2026-07-10','缺 basis','rate terminal 必须显式 basis','rate',5000)`
  ).run(rateAgreement, caseOne), /CHECK constraint/);
  assert.throws(() => fixture.prepare(
    `INSERT INTO fee_share_formula_revisions
       (agreement_id,case_id,revision_no,effective_on,label,change_note,
        result_kind,result_basis,result_rate_bps)
     VALUES (?,?,3,'2026-07-10','浮点 bps','bps 必须整数','rate','gross',5000.5)`
  ).run(rateAgreement, caseOne), /CHECK constraint/);
  assert.throws(() => fixture.prepare(
    `INSERT INTO fee_share_formula_deductions
       (revision_id,sequence,label,kind,basis,fixed_fen)
     VALUES (?,1,'fixed 不带 basis','fixed','gross',100)`
  ).run(rateRevision2), /CHECK constraint/);
  assert.throws(() => fixture.prepare(
    `INSERT INTO fee_share_formula_deductions
       (revision_id,sequence,label,kind,rate_bps)
     VALUES (?,1,'rate 缺 basis','rate',1000)`
  ).run(rateRevision2), /CHECK constraint/);
  assert.throws(() => fixture.prepare(
    `INSERT INTO fee_share_formula_deductions
       (revision_id,sequence,label,kind,basis,rate_bps)
     VALUES (?,1,'','rate','gross',1000)`
  ).run(rateRevision2), /CHECK constraint/);
  assert.throws(() => fixture.prepare(
    `INSERT INTO fee_share_formula_deductions
       (revision_id,sequence,label,kind,basis,rate_bps)
     VALUES (?,1,'浮点 bps','rate','gross',1000.5)`
  ).run(rateRevision2), /CHECK constraint/);
  assert.throws(() => fixture.prepare(
    `INSERT INTO fee_share_formula_deductions
       (revision_id,sequence,label,kind,fixed_fen)
     VALUES (?,1.5,'浮点序号','fixed',1)`
  ).run(rateRevision2), /CHECK constraint/);

  const deductionOne = Number(fixture.prepare(
    `INSERT INTO fee_share_formula_deductions
       (revision_id,sequence,label,kind,fixed_fen)
     VALUES (?,2,'固定成本', 'fixed',100)`
  ).run(rateRevision2).lastInsertRowid);
  assert.throws(() => fixture.prepare(
    "UPDATE fee_share_formula_revisions SET sealed=1,sealed_at='2026-07-10',sealed_by='fang' WHERE id=?"
  ).run(rateRevision2), /sequence must be contiguous/);
  fixture.prepare("UPDATE fee_share_formula_deductions SET sequence=1,label='固定成本（修订）' WHERE id=?").run(deductionOne);
  const deductionTwo = Number(fixture.prepare(
    `INSERT INTO fee_share_formula_deductions
       (revision_id,sequence,label,kind,basis,rate_bps)
     VALUES (?,2,'管理费','rate','gross',1000)`
  ).run(rateRevision2).lastInsertRowid);
  fixture.prepare('DELETE FROM fee_share_formula_deductions WHERE id=?').run(deductionTwo);
  const sealedDeductionTwo = Number(fixture.prepare(
    `INSERT INTO fee_share_formula_deductions
       (revision_id,sequence,label,kind,basis,rate_bps)
     VALUES (?,2,'管理费','rate','gross',1000)`
  ).run(rateRevision2).lastInsertRowid);
  fixture.prepare(
    "UPDATE fee_share_formula_revisions SET sealed=1,sealed_at='2026-07-10',sealed_by='fang' WHERE id=?"
  ).run(rateRevision2);
  assert.equal(fixture.prepare('SELECT sealed FROM fee_share_formula_revisions WHERE id=?').get(rateRevision2).sealed, 1);
  assert.throws(() => fixture.prepare(
    `INSERT INTO fee_share_formula_deductions
       (revision_id,sequence,label,kind,fixed_fen) VALUES (?,3,'封存后','fixed',1)`
  ).run(rateRevision2), /sealed/);
  assert.throws(() => fixture.prepare('UPDATE fee_share_formula_deductions SET label=? WHERE id=?').run('封存后改', sealedDeductionTwo), /sealed/);
  assert.throws(() => fixture.prepare('DELETE FROM fee_share_formula_deductions WHERE id=?').run(sealedDeductionTwo), /sealed/);
  assert.throws(() => fixture.prepare("UPDATE fee_share_formula_revisions SET sealed=0 WHERE id=?").run(rateRevision2), /one-way sealing/);
  assert.throws(() => fixture.prepare('DELETE FROM fee_share_formula_revisions WHERE id=?').run(rateRevision2), /immutable/);

  // pure fixed revision 封存时必须零 deductions；删掉未封存 deduction 后可 seal。
  const fixedRevision3 = Number(fixture.prepare(
    `INSERT INTO fee_share_formula_revisions
       (agreement_id,case_id,revision_no,effective_on,label,change_note,result_kind,result_fixed_fen)
     VALUES (?,?,3,'2026-07-11','固定三百','改用纯固定额','fixed',30000)`
  ).run(rateAgreement, caseOne).lastInsertRowid);
  const forbiddenFixedDeduction = Number(fixture.prepare(
    `INSERT INTO fee_share_formula_deductions
       (revision_id,sequence,label,kind,fixed_fen) VALUES (?,1,'不应存在','fixed',1)`
  ).run(fixedRevision3).lastInsertRowid);
  assert.throws(() => fixture.prepare(
    "UPDATE fee_share_formula_revisions SET sealed=1,sealed_at='2026-07-11',sealed_by='fang' WHERE id=?"
  ).run(fixedRevision3), /fixed terminal revision cannot contain deductions/);
  fixture.prepare('DELETE FROM fee_share_formula_deductions WHERE id=?').run(forbiddenFixedDeduction);
  fixture.prepare(
    "UPDATE fee_share_formula_revisions SET sealed=1,sealed_at='2026-07-11',sealed_by='fang' WHERE id=?"
  ).run(fixedRevision3);

  const unsealedRevision4 = Number(fixture.prepare(
    `INSERT INTO fee_share_formula_revisions
       (agreement_id,case_id,revision_no,effective_on,label,change_note,
        result_kind,result_basis,result_rate_bps)
     VALUES (?,?,4,'2026-07-12','未封存版','用于 assignment 拒绝测试','rate','gross',2500)`
  ).run(rateAgreement, caseOne).lastInsertRowid);

  // assignment：unpaid/paid 均可规划；active payable + sealed pinned revision 不变；N/A 不带 revision。
  const planFee = insertFee(fixture, caseOne, '方案款', 1234.56);
  const spareFee = insertFee(fixture, caseOne, '方案拒绝样例', 100);
  const paidAdoptionFee = insertFee(fixture, caseOne, '既有已收待纳管款', 500, 'paid', '2026-07-15');
  assert.throws(() => insertAssignment(fixture, {
    caseId: caseOne, feeItemId: spareFee, agreementId: rateAgreement,
    formulaRevisionId: unsealedRevision4,
  }), /sealed pinned revision/);
  assert.throws(() => insertAssignment(fixture, {
    caseId: caseOne, feeItemId: spareFee, agreementId: rateAgreement,
    formulaRevisionId: otherRevision1,
  }), /sealed pinned revision|FOREIGN KEY/);
  assert.throws(() => insertAssignment(fixture, {
    caseId: caseOne, feeItemId: spareFee, agreementId: rateAgreement,
    status: 'not_applicable', formulaRevisionId: rateRevision1,
  }), /CHECK constraint/);

  const receivableAgreement = Number(fixture.prepare(
    `INSERT INTO fee_share_agreements (case_id,direction,counterpart,rate)
     VALUES (?,'receivable','外部应收甲',10)`
  ).run(caseOne).lastInsertRowid);
  assert.throws(() => insertAssignment(fixture, {
    caseId: caseOne, feeItemId: spareFee, agreementId: receivableAgreement,
    status: 'not_applicable',
  }), /active payable/);
  fixture.prepare("UPDATE fee_share_agreements SET status='retired' WHERE id=?").run(otherAgreement);
  assert.throws(() => insertAssignment(fixture, {
    caseId: caseTwo, feeItemId: feeTwo, agreementId: otherAgreement,
    formulaRevisionId: otherRevision1,
  }), /active payable/);

  const assignmentRate = insertAssignment(fixture, {
    caseId: caseOne, feeItemId: planFee, agreementId: rateAgreement,
    formulaRevisionId: rateRevision1, decisionNote: '人工选择 legacy revision 1',
  });
  const assignmentFlat = insertAssignment(fixture, {
    caseId: caseOne, feeItemId: planFee, agreementId: flatAgreement,
    status: 'not_applicable', decisionNote: '初次确认本款不适用固定约定',
  });
  const paidAssignment = insertAssignment(fixture, {
    caseId: caseOne, feeItemId: paidAdoptionFee, agreementId: rateAgreement,
    formulaRevisionId: rateRevision1, decisionNote: '已收历史款首次纳入引擎',
  });
  assert.ok(paidAssignment, 'already-paid legacy fee 可建立初始 assignment');
  assert.deepEqual(fixture.prepare(
    'SELECT formula_revision_id,revision_choice,version FROM fee_share_assignments WHERE id=?'
  ).get(assignmentRate), { formula_revision_id: rateRevision1, revision_choice: 'initial', version: 1 });
  assert.throws(() => insertAssignment(fixture, {
    caseId: caseOne, feeItemId: planFee, agreementId: rateAgreement,
    formulaRevisionId: rateRevision1,
  }), /UNIQUE/);

  // assignment 只能原身份原 created_at 地精确 +1 更新；跳号、漏加版本或静默改身份均拒绝。
  const assignmentBefore = fixture.prepare(
    'SELECT id,case_id,fee_item_id,agreement_id,created_at,updated_at FROM fee_share_assignments WHERE id=?'
  ).get(assignmentRate);
  assert.throws(() => fixture.prepare(
    "UPDATE fee_share_assignments SET decision_note='漏加版本',updated_at='2026-07-20 10:00:00' WHERE id=?"
  ).run(assignmentRate), /increment version by one/);
  assert.throws(() => fixture.prepare(
    "UPDATE fee_share_assignments SET version=3,updated_at='2026-07-20 10:00:00' WHERE id=?"
  ).run(assignmentRate), /increment version by one/);
  assert.throws(() => fixture.prepare(
    "UPDATE fee_share_assignments SET fee_item_id=?,version=2,updated_at='2026-07-20 10:00:00' WHERE id=?"
  ).run(spareFee, assignmentRate), /preserve identity/);
  const receiptFormula = '{"result_kind":"rate","result_basis":"gross","result_rate_bps":3333,"deductions":[]}';
  const receiptTrace = '[{"step":"result","calculated_amount_fen":41148,"applied_amount_fen":41148,"clamped":false}]';
  const correctionFormula = '{"result_kind":"rate","result_basis":"remaining","result_rate_bps":5000,"deductions":[{"sequence":1,"label":"固定成本（修订）","kind":"fixed","fixed_fen":100},{"sequence":2,"label":"管理费","kind":"rate","basis":"gross","rate_bps":1000}]}';
  const correctionTrace1 = '[{"step":"result","calculated_amount_fen":55505,"applied_amount_fen":55505,"clamped":false}]';
  const flatFormula1 = '{"result_kind":"fixed","result_fixed_fen":20025,"deductions":[]}';
  const flatTrace1 = '[{"step":"result","calculated_amount_fen":20025,"applied_amount_fen":20025,"clamped":false}]';

  // 已经 paid 的 legacy fee 仍可执行首次 receipt/adoption，而不是要求先改回 unpaid。
  const adoptionRun = insertRun(fixture, {
    caseId: caseOne, feeItemId: paidAdoptionFee, kind: 'receipt',
    previewHash: 'paid-adoption-preview', baseFen: 50000, feeVersion: 1,
    targetStatus: 'paid', paidOn: '2026-07-15',
  });
  const adoptionSnapshot = insertSnapshot(fixture, {
    runId: adoptionRun, caseId: caseOne, feeItemId: paidAdoptionFee,
    agreementId: rateAgreement, revisionId: rateRevision1, assignmentId: paidAssignment,
    planVersion: 1, revisionChoice: 'initial', counterpart: '王五',
    formulaJson: receiptFormula, traceJson: '[{"step":"result","calculated_amount_fen":16665,"applied_amount_fen":16665,"clamped":false}]',
    baseFen: 50000, desiredFen: 16665, closedFen: 0, newFen: 16665,
    entryKind: 'calculated', dueMonth: '2026-07',
  });
  const adoptionShare = insertEngineShare(fixture, {
    caseId: caseOne, agreementId: rateAgreement, feeItemId: paidAdoptionFee,
    assignmentId: paidAssignment, snapshotId: adoptionSnapshot, entryKind: 'calculated',
    counterpart: '王五', baseFen: 50000, amountFen: 16665, dueMonth: '2026-07',
  });
  assert.ok(adoptionShare);

  // receipt snapshot 固化 plan version；当前 assignment 必须仍钉住 snapshot revision。
  // 为先建立 revision 1 receipt，临时使用另一款项的独立 assignment。
  const receiptAssignment = insertAssignment(fixture, {
    caseId: caseOne, feeItemId: spareFee, agreementId: rateAgreement,
    formulaRevisionId: rateRevision1,
  });
  const receiptRun = insertRun(fixture, {
    caseId: caseOne, feeItemId: spareFee, kind: 'receipt', previewHash: 'receipt-preview',
    baseFen: 123456, feeVersion: 1, targetStatus: 'paid', paidOn: '2026-07-20',
  });
  const receiptSnapshot = insertSnapshot(fixture, {
    runId: receiptRun, caseId: caseOne, feeItemId: spareFee,
    agreementId: rateAgreement, revisionId: rateRevision1, assignmentId: receiptAssignment,
    planVersion: 1, revisionChoice: 'initial', counterpart: '王五',
    formulaJson: receiptFormula, traceJson: receiptTrace, baseFen: 123456,
    desiredFen: 41148, closedFen: 0, newFen: 41148,
    entryKind: 'calculated', dueMonth: '2026-07',
  });
  assert.deepEqual(fixture.prepare(
    `SELECT plan_version,revision_choice,base_amount_fen,desired_amount_fen,
            closed_amount_fen,new_amount_fen
       FROM fee_share_settlement_snapshots WHERE id=?`
  ).get(receiptSnapshot), {
    plan_version: 1, revision_choice: 'initial', base_amount_fen: 123456,
    desired_amount_fen: 41148, closed_amount_fen: 0, new_amount_fen: 41148,
  });

  // engine REAL 只是 canonical fen 的确定性兼容投影；错一分或省略 fen 均不得反推覆盖。
  assert.throws(() => fixture.prepare(
    `INSERT INTO fee_shares
       (case_id,agreement_id,fee_item_id,assignment_id,settlement_snapshot_id,entry_kind,
        direction,counterpart,base_amount,base_amount_fen,amount,amount_fen,due_month)
     VALUES (?,?,?,?,?,'calculated','payable','王五',1234.56,123456,411.49,41148,'2026-07')`
  ).run(caseOne, rateAgreement, spareFee, receiptAssignment, receiptSnapshot), /deterministic engine fen projection/);
  assert.throws(() => fixture.prepare(
    `INSERT INTO fee_shares
       (case_id,agreement_id,fee_item_id,assignment_id,settlement_snapshot_id,entry_kind,
        direction,counterpart,base_amount,base_amount_fen,amount,due_month)
     VALUES (?,?,?,?,?,'calculated','payable','王五',1234.56,123456,411.48,'2026-07')`
  ).run(caseOne, rateAgreement, spareFee, receiptAssignment, receiptSnapshot), /deterministic engine fen projection|settlement source mismatch|do not match/);
  const calculatedShare = insertEngineShare(fixture, {
    caseId: caseOne, agreementId: rateAgreement, feeItemId: spareFee,
    assignmentId: receiptAssignment, snapshotId: receiptSnapshot, entryKind: 'calculated',
    counterpart: '王五', baseFen: 123456, amountFen: 41148, dueMonth: '2026-07',
  });
  assert.throws(() => fixture.prepare(
    'UPDATE fee_shares SET status=?,settled_on=? WHERE id=?'
  ).run('settled', '', calculatedShare), /status transition/);
  assert.throws(() => fixture.prepare('UPDATE fee_shares SET amount=? WHERE id=?').run(1, calculatedShare), /immutable/);
  assert.throws(() => fixture.prepare('DELETE FROM fee_shares WHERE id=?').run(calculatedShare), /cannot be deleted/);

  // 主链方案：receipt 固化 revision 1/version 1；随后 assignment 精确 +1 采用 revision 2，
  // correction 可以使用新的 plan version/revision，而旧 snapshot 继续保留历史版本。
  const planReceiptRun = insertRun(fixture, {
    caseId: caseOne, feeItemId: planFee, kind: 'receipt', previewHash: 'plan-receipt-preview',
    baseFen: 123456, feeVersion: 1, targetStatus: 'paid', paidOn: '2026-07-20',
  });
  const planReceiptSnapshot = insertSnapshot(fixture, {
    runId: planReceiptRun, caseId: caseOne, feeItemId: planFee,
    agreementId: rateAgreement, revisionId: rateRevision1, assignmentId: assignmentRate,
    planVersion: 1, revisionChoice: 'initial', counterpart: '王五',
    formulaJson: receiptFormula, traceJson: receiptTrace, baseFen: 123456,
    desiredFen: 41148, closedFen: 0, newFen: 41148,
    entryKind: 'calculated', dueMonth: '2026-07',
  });
  const planReceiptShare = insertEngineShare(fixture, {
    caseId: caseOne, agreementId: rateAgreement, feeItemId: planFee,
    assignmentId: assignmentRate, snapshotId: planReceiptSnapshot, entryKind: 'calculated',
    counterpart: '王五', baseFen: 123456, amountFen: 41148, dueMonth: '2026-07',
  });
  fixture.prepare(
    `UPDATE fee_share_assignments
        SET formula_revision_id=?,revision_choice='adopt_latest',decision_note='采用 revision 2',
            version=2,updated_at='2026-07-20 10:00:00'
      WHERE id=?`
  ).run(rateRevision2, assignmentRate);
  assert.deepEqual(fixture.prepare(
    `SELECT id,case_id,fee_item_id,agreement_id,created_at,formula_revision_id,
            revision_choice,version,updated_at
       FROM fee_share_assignments WHERE id=?`
  ).get(assignmentRate), {
    id: assignmentBefore.id,
    case_id: assignmentBefore.case_id,
    fee_item_id: assignmentBefore.fee_item_id,
    agreement_id: assignmentBefore.agreement_id,
    created_at: assignmentBefore.created_at,
    formula_revision_id: rateRevision2,
    revision_choice: 'adopt_latest',
    version: 2,
    updated_at: '2026-07-20 10:00:00',
  });

  // flat assignment 从 N/A 改为 assigned 也必须精确 +1；它会在 correction 中作为新 agreement（无 source snapshot）加入。
  fixture.prepare(
    `UPDATE fee_share_assignments
        SET status='assigned',formula_revision_id=?,revision_choice='initial',
            decision_note='更正时新纳入固定约定',version=2,updated_at='2026-08-01 09:00:00'
      WHERE id=?`
  ).run(flatRevision1, assignmentFlat);

  const correctionRun1 = insertRun(fixture, {
    caseId: caseOne, feeItemId: planFee, kind: 'correction', sourceRunId: planReceiptRun,
    requestId: 'correction-1', previewHash: 'correction-preview-1', baseFen: 123456,
    feeVersion: 2, targetStatus: 'paid', paidOn: '2026-08-01', reason: '新纳入固定约定',
  });
  assert.throws(() => insertRun(fixture, {
    caseId: caseOne, feeItemId: planFee, kind: 'correction', sourceRunId: planReceiptRun,
    requestId: 'correction-1b', previewHash: 'correction-preview-1b', baseFen: 123456,
    feeVersion: 2, targetStatus: 'paid', paidOn: '2026-08-01', reason: '同一 source 不得分叉',
  }), /UNIQUE/);
  assert.throws(() => insertRun(fixture, {
    caseId: caseOne, feeItemId: spareFee, kind: 'correction', sourceRunId: planReceiptRun,
    requestId: 'cross-fee', previewHash: 'cross-fee-preview', baseFen: 123456,
    feeVersion: 1, targetStatus: 'paid', paidOn: '2026-08-01', reason: '不应跨款',
  }), /invalid correction|FOREIGN KEY/);

  // 未有本 run snapshot 时不能取消旧 pending。
  assert.throws(() => fixture.prepare(
    'UPDATE fee_shares SET cancelled_at=?,cancel_reason=?,cancelled_by_run_id=? WHERE id=?'
  ).run('2026-08-01', '尚无 correction snapshot', correctionRun1, planReceiptShare), /requires an uncancelled pending/);

  assert.throws(() => insertSnapshot(fixture, {
    runId: correctionRun1, caseId: caseOne, feeItemId: planFee,
    agreementId: rateAgreement, revisionId: rateRevision2, assignmentId: assignmentRate,
    planVersion: 1, revisionChoice: 'adopt_latest', sourceSnapshotId: planReceiptSnapshot,
    counterpart: '王五', formulaJson: correctionFormula, traceJson: correctionTrace1,
    baseFen: 123456, desiredFen: 55505, closedFen: 0, newFen: 55505,
    entryKind: 'adjustment', dueMonth: '2026-08',
  }), /current assignment/);
  assert.throws(() => insertSnapshot(fixture, {
    runId: correctionRun1, caseId: caseOne, feeItemId: planFee,
    agreementId: rateAgreement, revisionId: rateRevision1, assignmentId: assignmentRate,
    planVersion: 2, revisionChoice: 'adopt_latest', sourceSnapshotId: planReceiptSnapshot,
    counterpart: '王五', formulaJson: receiptFormula, traceJson: receiptTrace,
    baseFen: 123456, desiredFen: 41148, closedFen: 0, newFen: 41148,
    entryKind: 'adjustment', dueMonth: '2026-08',
  }), /current assignment/);
  // 旧 pending 不是 closed；把 previous desired 当 closed 会被拒绝。
  assert.throws(() => insertSnapshot(fixture, {
    runId: correctionRun1, caseId: caseOne, feeItemId: planFee,
    agreementId: rateAgreement, revisionId: rateRevision2, assignmentId: assignmentRate,
    planVersion: 2, revisionChoice: 'adopt_latest', sourceSnapshotId: planReceiptSnapshot,
    counterpart: '王五', formulaJson: correctionFormula, traceJson: correctionTrace1,
    baseFen: 123456, desiredFen: 55505, closedFen: 55505, newFen: 0,
    entryKind: 'adjustment', dueMonth: '2026-08',
  }), /closed_amount_fen/);
  const correctionSnapshot1 = insertSnapshot(fixture, {
    runId: correctionRun1, caseId: caseOne, feeItemId: planFee,
    agreementId: rateAgreement, revisionId: rateRevision2, assignmentId: assignmentRate,
    planVersion: 2, revisionChoice: 'adopt_latest', sourceSnapshotId: planReceiptSnapshot,
    counterpart: '王五', formulaJson: correctionFormula, traceJson: correctionTrace1,
    baseFen: 123456, desiredFen: 55505, closedFen: 0, newFen: 55505,
    entryKind: 'adjustment', dueMonth: '2026-08',
  });
  const flatSnapshot1 = insertSnapshot(fixture, {
    runId: correctionRun1, caseId: caseOne, feeItemId: planFee,
    agreementId: flatAgreement, revisionId: flatRevision1, assignmentId: assignmentFlat,
    planVersion: 2, revisionChoice: 'initial', sourceSnapshotId: null,
    counterpart: '赵六', formulaJson: flatFormula1, traceJson: flatTrace1,
    baseFen: 123456, desiredFen: 20025, closedFen: 0, newFen: 20025,
    entryKind: 'adjustment', dueMonth: '2026-08',
  });
  assert.equal(fixture.prepare(
    'SELECT source_snapshot_id FROM fee_share_settlement_snapshots WHERE id=?'
  ).get(flatSnapshot1).source_snapshot_id, null, 'correction 可为新 agreement 建无 source snapshot 的快照');

  // partial unique index 强制顺序：snapshot → cancel old pending → insert replacement。
  assert.throws(() => insertEngineShare(fixture, {
    caseId: caseOne, agreementId: rateAgreement, feeItemId: planFee,
    assignmentId: assignmentRate, snapshotId: correctionSnapshot1, entryKind: 'adjustment',
    counterpart: '王五', baseFen: 123456, amountFen: 55505, dueMonth: '2026-08',
  }), /UNIQUE/);
  fixture.prepare(
    'UPDATE fee_shares SET cancelled_at=?,cancel_reason=?,cancelled_by_run_id=? WHERE id=?'
  ).run('2026-08-01', '由 correction-1 取代', correctionRun1, planReceiptShare);
  assert.throws(() => fixture.prepare(
    'UPDATE fee_shares SET status=?,settled_on=? WHERE id=?'
  ).run('settled', '2026-08-01', planReceiptShare), /status transition/);
  assert.throws(() => fixture.prepare(
    'UPDATE fee_shares SET cancel_reason=? WHERE id=?'
  ).run('二次修改不允许', planReceiptShare), /uncancelled pending/);
  const correctionShare1 = insertEngineShare(fixture, {
    caseId: caseOne, agreementId: rateAgreement, feeItemId: planFee,
    assignmentId: assignmentRate, snapshotId: correctionSnapshot1, entryKind: 'adjustment',
    counterpart: '王五', baseFen: 123456, amountFen: 55505, dueMonth: '2026-08',
  });
  const flatShare1 = insertEngineShare(fixture, {
    caseId: caseOne, agreementId: flatAgreement, feeItemId: planFee,
    assignmentId: assignmentFlat, snapshotId: flatSnapshot1, entryKind: 'adjustment',
    counterpart: '赵六', baseFen: 123456, amountFen: 20025, dueMonth: '2026-08',
  });
  fixture.prepare("UPDATE fee_shares SET due_month='2026-09',note='人工调整付款排程' WHERE id=?").run(correctionShare1);
  assert.deepEqual(fixture.prepare(
    'SELECT due_month,note FROM fee_shares WHERE id=?'
  ).get(correctionShare1), { due_month: '2026-09', note: '人工调整付款排程' });
  assert.throws(() => fixture.prepare("UPDATE fee_shares SET due_month='2026-13' WHERE id=?").run(correctionShare1), /YYYY-MM/);
  assert.equal(fixture.prepare(
    'SELECT due_month FROM fee_share_settlement_snapshots WHERE id=?'
  ).get(correctionSnapshot1).due_month, '2026-08', '台账排程可改但 snapshot 不变');
  fixture.prepare("UPDATE fee_shares SET status='settled',settled_on='2026-08-20' WHERE id=?").run(correctionShare1);
  fixture.prepare("UPDATE fee_shares SET status='waived' WHERE id=?").run(flatShare1);

  // flat 新 revision 供下一次 correction 显式 adopt；assignment 再次只 +1。
  const flatRevision2 = Number(fixture.prepare(
    `INSERT INTO fee_share_formula_revisions
       (agreement_id,case_id,revision_no,effective_on,label,change_note,result_kind,result_fixed_fen)
     VALUES (?,?,2,'2026-08-15','固定三百','明确提高固定分成','fixed',30000)`
  ).run(flatAgreement, caseOne).lastInsertRowid);
  fixture.prepare(
    "UPDATE fee_share_formula_revisions SET sealed=1,sealed_at='2026-08-15',sealed_by='fang' WHERE id=?"
  ).run(flatRevision2);
  fixture.prepare(
    `UPDATE fee_share_assignments
        SET formula_revision_id=?,revision_choice='adopt_latest',decision_note='采用固定 revision 2',
            version=3,updated_at='2026-08-15 10:00:00'
      WHERE id=?`
  ).run(flatRevision2, assignmentFlat);

  const correctionRun2 = insertRun(fixture, {
    caseId: caseOne, feeItemId: planFee, kind: 'correction', sourceRunId: correctionRun1,
    requestId: 'correction-2', previewHash: 'correction-preview-2', baseFen: 150000,
    feeVersion: 3, targetStatus: 'paid', paidOn: '2026-09-01', reason: '基数与固定约定更新',
  });
  const correctionTrace2 = '[{"step":"result","calculated_amount_fen":67450,"applied_amount_fen":67450,"clamped":false}]';
  // settled 55505 是 closed；source snapshot 可以是更早的 formula lineage，不必属于 immediate source run。
  assert.throws(() => insertSnapshot(fixture, {
    runId: correctionRun2, caseId: caseOne, feeItemId: planFee,
    agreementId: rateAgreement, revisionId: rateRevision2, assignmentId: assignmentRate,
    planVersion: 2, revisionChoice: 'adopt_latest', sourceSnapshotId: planReceiptSnapshot,
    counterpart: '王五', formulaJson: correctionFormula, traceJson: correctionTrace2,
    baseFen: 150000, desiredFen: 67450, closedFen: 0, newFen: 67450,
    entryKind: 'adjustment', dueMonth: '2026-09',
  }), /closed_amount_fen/);
  const correctionSnapshot2 = insertSnapshot(fixture, {
    runId: correctionRun2, caseId: caseOne, feeItemId: planFee,
    agreementId: rateAgreement, revisionId: rateRevision2, assignmentId: assignmentRate,
    planVersion: 2, revisionChoice: 'adopt_latest', sourceSnapshotId: planReceiptSnapshot,
    counterpart: '王五', formulaJson: correctionFormula, traceJson: correctionTrace2,
    baseFen: 150000, desiredFen: 67450, closedFen: 55505, newFen: 11945,
    entryKind: 'adjustment', dueMonth: '2026-09',
  });
  const flatFormula2 = '{"result_kind":"fixed","result_fixed_fen":30000,"deductions":[]}';
  const flatTrace2 = '[{"step":"result","calculated_amount_fen":30000,"applied_amount_fen":30000,"clamped":false}]';
  // waived 20025 对 correction 视为 closed，因此只新增 9975。
  assert.throws(() => insertSnapshot(fixture, {
    runId: correctionRun2, caseId: caseOne, feeItemId: planFee,
    agreementId: flatAgreement, revisionId: flatRevision2, assignmentId: assignmentFlat,
    planVersion: 3, revisionChoice: 'adopt_latest', sourceSnapshotId: flatSnapshot1,
    counterpart: '赵六', formulaJson: flatFormula2, traceJson: flatTrace2,
    baseFen: 150000, desiredFen: 30000, closedFen: 0, newFen: 30000,
    entryKind: 'adjustment', dueMonth: '2026-09',
  }), /closed_amount_fen/);
  const flatSnapshot2 = insertSnapshot(fixture, {
    runId: correctionRun2, caseId: caseOne, feeItemId: planFee,
    agreementId: flatAgreement, revisionId: flatRevision2, assignmentId: assignmentFlat,
    planVersion: 3, revisionChoice: 'adopt_latest', sourceSnapshotId: flatSnapshot1,
    counterpart: '赵六', formulaJson: flatFormula2, traceJson: flatTrace2,
    baseFen: 150000, desiredFen: 30000, closedFen: 20025, newFen: 9975,
    entryKind: 'adjustment', dueMonth: '2026-09',
  });
  assert.throws(() => fixture.prepare(
    'UPDATE fee_shares SET cancelled_at=?,cancel_reason=?,cancelled_by_run_id=? WHERE id=?'
  ).run('2026-09-01', 'settled 不可取消', correctionRun2, correctionShare1), /uncancelled pending/);
  assert.throws(() => fixture.prepare(
    'UPDATE fee_shares SET cancelled_at=?,cancel_reason=?,cancelled_by_run_id=? WHERE id=?'
  ).run('2026-09-01', 'waived 不可取消', correctionRun2, flatShare1), /uncancelled pending/);
  const correctionShare2 = insertEngineShare(fixture, {
    caseId: caseOne, agreementId: rateAgreement, feeItemId: planFee,
    assignmentId: assignmentRate, snapshotId: correctionSnapshot2, entryKind: 'adjustment',
    counterpart: '王五', baseFen: 150000, amountFen: 11945, dueMonth: '2026-09',
  });
  const flatShare2 = insertEngineShare(fixture, {
    caseId: caseOne, agreementId: flatAgreement, feeItemId: planFee,
    assignmentId: assignmentFlat, snapshotId: flatSnapshot2, entryKind: 'adjustment',
    counterpart: '赵六', baseFen: 150000, amountFen: 9975, dueMonth: '2026-09',
  });

  // reversal 只能接 paid receipt/correction；同一 source 仍只有一个后继。
  const reversalRun = insertRun(fixture, {
    caseId: caseOne, feeItemId: planFee, kind: 'reversal', sourceRunId: correctionRun2,
    requestId: 'reversal-1', previewHash: 'reversal-preview-1', baseFen: 150000,
    feeVersion: 4, targetStatus: 'unpaid', reason: '撤销收讫',
  });
  assert.throws(() => insertRun(fixture, {
    caseId: caseOne, feeItemId: planFee, kind: 'correction', sourceRunId: correctionRun2,
    requestId: 'correction-after-used-source', previewHash: 'used-source-preview', baseFen: 150000,
    feeVersion: 4, targetStatus: 'paid', paidOn: '2026-09-02', reason: '不得分叉',
  }), /UNIQUE/);

  // reversal 对 settled 计 closed，故产生负 adjustment；pending 不计 closed、稍后取消。
  const reversalRateSnapshot = insertSnapshot(fixture, {
    runId: reversalRun, caseId: caseOne, feeItemId: planFee,
    agreementId: rateAgreement, revisionId: rateRevision2, assignmentId: assignmentRate,
    planVersion: 2, revisionChoice: 'source', sourceSnapshotId: correctionSnapshot2,
    counterpart: '王五', formulaJson: correctionFormula, traceJson: correctionTrace2,
    baseFen: 150000, desiredFen: 0, closedFen: 55505, newFen: -55505,
    entryKind: 'adjustment', dueMonth: '2026-09',
  });
  // waived 在 reversal 中不反向恢复，因此 closed=0/new=0；按 correction 口径填 20025 必须拒绝。
  assert.throws(() => insertSnapshot(fixture, {
    runId: reversalRun, caseId: caseOne, feeItemId: planFee,
    agreementId: flatAgreement, revisionId: flatRevision2, assignmentId: assignmentFlat,
    planVersion: 3, revisionChoice: 'source', sourceSnapshotId: flatSnapshot2,
    counterpart: '赵六', formulaJson: flatFormula2, traceJson: flatTrace2,
    baseFen: 150000, desiredFen: 0, closedFen: 20025, newFen: -20025,
    entryKind: 'adjustment', dueMonth: '2026-09',
  }), /closed_amount_fen/);
  const reversalFlatSnapshot = insertSnapshot(fixture, {
    runId: reversalRun, caseId: caseOne, feeItemId: planFee,
    agreementId: flatAgreement, revisionId: flatRevision2, assignmentId: assignmentFlat,
    planVersion: 3, revisionChoice: 'source', sourceSnapshotId: flatSnapshot2,
    counterpart: '赵六', formulaJson: flatFormula2, traceJson: flatTrace2,
    baseFen: 150000, desiredFen: 0, closedFen: 0, newFen: 0,
    entryKind: 'adjustment', dueMonth: '2026-09',
  });
  fixture.prepare(
    'UPDATE fee_shares SET cancelled_at=?,cancel_reason=?,cancelled_by_run_id=? WHERE id=?'
  ).run('2026-09-02', '由 reversal-1 取代', reversalRun, correctionShare2);
  fixture.prepare(
    'UPDATE fee_shares SET cancelled_at=?,cancel_reason=?,cancelled_by_run_id=? WHERE id=?'
  ).run('2026-09-02', '由 reversal-1 取代', reversalRun, flatShare2);
  const reversalRateShare = insertEngineShare(fixture, {
    caseId: caseOne, agreementId: rateAgreement, feeItemId: planFee,
    assignmentId: assignmentRate, snapshotId: reversalRateSnapshot, entryKind: 'adjustment',
    counterpart: '王五', baseFen: 150000, amountFen: -55505, dueMonth: '2026-09',
  });
  const reversalFlatShare = insertEngineShare(fixture, {
    caseId: caseOne, agreementId: flatAgreement, feeItemId: planFee,
    assignmentId: assignmentFlat, snapshotId: reversalFlatSnapshot, entryKind: 'adjustment',
    counterpart: '赵六', baseFen: 150000, amountFen: 0, dueMonth: '2026-09',
  });
  fixture.prepare("UPDATE fee_shares SET status='settled',settled_on='2026-09-02' WHERE id=?").run(reversalRateShare);
  fixture.prepare("UPDATE fee_shares SET status='waived' WHERE id=?").run(reversalFlatShare);
  assert.throws(() => insertRun(fixture, {
    caseId: caseOne, feeItemId: planFee, kind: 'reversal', sourceRunId: reversalRun,
    requestId: 'reversal-from-reversal', previewHash: 'reversal-from-reversal-preview', baseFen: 150000,
    feeVersion: 5, targetStatus: 'unpaid', reason: 'reversal 不能接 reversal',
  }), /invalid correction/);

  // reversal 后不得再建第二个 receipt；以 correction 作为其唯一后继即可重新收讫。
  fixture.prepare("UPDATE fee_items SET status='unpaid',paid_on='' WHERE id=?").run(planFee);
  const reReceiptRun = insertRun(fixture, {
    caseId: caseOne, feeItemId: planFee, kind: 'correction', sourceRunId: reversalRun,
    requestId: 're-receipt-after-reversal', previewHash: 're-receipt-preview', baseFen: 160000,
    feeVersion: 5, targetStatus: 'paid', paidOn: '2026-10-01', reason: '冲销后再次收讫',
  });
  const reReceiptTrace = '[{"step":"result","calculated_amount_fen":71950,"applied_amount_fen":71950,"clamped":false}]';
  const reReceiptSnapshot = insertSnapshot(fixture, {
    runId: reReceiptRun, caseId: caseOne, feeItemId: planFee,
    agreementId: rateAgreement, revisionId: rateRevision2, assignmentId: assignmentRate,
    planVersion: 2, revisionChoice: 'adopt_latest', sourceSnapshotId: correctionSnapshot2,
    counterpart: '王五', formulaJson: correctionFormula, traceJson: reReceiptTrace,
    baseFen: 160000, desiredFen: 71950, closedFen: 0, newFen: 71950,
    entryKind: 'adjustment', dueMonth: '2026-10',
  });
  const reReceiptShare = insertEngineShare(fixture, {
    caseId: caseOne, agreementId: rateAgreement, feeItemId: planFee,
    assignmentId: assignmentRate, snapshotId: reReceiptSnapshot, entryKind: 'adjustment',
    counterpart: '王五', baseFen: 160000, amountFen: 71950, dueMonth: '2026-10',
  });
  assert.ok(reReceiptShare);
  assert.throws(() => insertRun(fixture, {
    caseId: caseOne, feeItemId: planFee, kind: 'receipt', previewHash: 'second-receipt-preview',
    baseFen: 160000, feeVersion: 5, targetStatus: 'paid', paidOn: '2026-10-01',
  }), /UNIQUE/);
  assert.throws(() => insertRun(fixture, {
    caseId: caseOne, feeItemId: planFee, kind: 'correction', sourceRunId: reversalRun,
    requestId: 'second-re-receipt', previewHash: 'second-re-receipt-preview', baseFen: 160000,
    feeVersion: 5, targetStatus: 'paid', paidOn: '2026-10-01', reason: '仍不得分叉',
  }), /UNIQUE/);

  assert.throws(() => fixture.prepare('UPDATE fee_share_settlement_runs SET reason=? WHERE id=?').run('改历史', correctionRun1), /immutable/);
  assert.throws(() => fixture.prepare('DELETE FROM fee_share_settlement_runs WHERE id=?').run(correctionRun1), /immutable/);
  assert.throws(() => fixture.prepare('UPDATE fee_share_settlement_snapshots SET trace_json=? WHERE id=?').run('[]', correctionSnapshot1), /immutable/);
  assert.throws(() => fixture.prepare('DELETE FROM fee_share_settlement_snapshots WHERE id=?').run(correctionSnapshot1), /immutable/);

  // pure fixed 可使用 unknown base；rate snapshot 在 NULL base 下必须拒绝。
  const fixedFee = insertFee(fixture, caseOne, '固定额未知基数款', null);
  const fixedAssignment = insertAssignment(fixture, {
    caseId: caseOne, feeItemId: fixedFee, agreementId: flatAgreement,
    formulaRevisionId: flatRevision1,
  });
  const fixedRun = insertRun(fixture, {
    caseId: caseOne, feeItemId: fixedFee, kind: 'receipt', previewHash: 'fixed-preview',
    baseFen: null, feeVersion: 1, targetStatus: 'paid', paidOn: '2026-11-01',
  });
  const fixedSnapshot = insertSnapshot(fixture, {
    runId: fixedRun, caseId: caseOne, feeItemId: fixedFee,
    agreementId: flatAgreement, revisionId: flatRevision1, assignmentId: fixedAssignment,
    planVersion: 1, revisionChoice: 'initial', counterpart: '赵六',
    formulaJson: flatFormula1, traceJson: flatTrace1, baseFen: null,
    desiredFen: 20025, closedFen: 0, newFen: 20025,
    entryKind: 'calculated', dueMonth: '2026-11',
  });
  const fixedEngineShare = insertEngineShare(fixture, {
    caseId: caseOne, agreementId: flatAgreement, feeItemId: fixedFee,
    assignmentId: fixedAssignment, snapshotId: fixedSnapshot, entryKind: 'calculated',
    counterpart: '赵六', baseFen: null, amountFen: 20025, dueMonth: '2026-11',
  });
  assert.deepEqual(fixture.prepare(
    'SELECT base_amount,base_amount_fen,amount_fen FROM fee_shares WHERE id=?'
  ).get(fixedEngineShare), { base_amount: null, base_amount_fen: null, amount_fen: 20025 });

  const unknownRateFee = insertFee(fixture, caseOne, '比例未知基数款', null);
  const unknownRateAssignment = insertAssignment(fixture, {
    caseId: caseOne, feeItemId: unknownRateFee, agreementId: rateAgreement,
    formulaRevisionId: rateRevision1,
  });
  const unknownRateRun = insertRun(fixture, {
    caseId: caseOne, feeItemId: unknownRateFee, kind: 'receipt', previewHash: 'unknown-rate-preview',
    baseFen: null, feeVersion: 1, targetStatus: 'paid', paidOn: '2026-11-02',
  });
  assert.throws(() => insertSnapshot(fixture, {
    runId: unknownRateRun, caseId: caseOne, feeItemId: unknownRateFee,
    agreementId: rateAgreement, revisionId: rateRevision1, assignmentId: unknownRateAssignment,
    planVersion: 1, revisionChoice: 'initial', counterpart: '王五',
    formulaJson: receiptFormula, traceJson: '[]', baseFen: null,
    desiredFen: 0, closedFen: 0, newFen: 0,
    entryKind: 'calculated', dueMonth: '2026-11',
  }), /snapshot facts/);

  // max-safe canonical fen 的 engine REAL 投影可写入，且绝不通过 ROUND(REAL*100) 回算。
  const flatRevision3 = Number(fixture.prepare(
    `INSERT INTO fee_share_formula_revisions
       (agreement_id,case_id,revision_no,effective_on,label,change_note,result_kind,result_fixed_fen)
     VALUES (?,?,3,'2026-11-03','最大安全整数分','边界投影测试','fixed',?)`
  ).run(flatAgreement, caseOne, Number.MAX_SAFE_INTEGER).lastInsertRowid);
  fixture.prepare(
    "UPDATE fee_share_formula_revisions SET sealed=1,sealed_at='2026-11-03',sealed_by='fang' WHERE id=?"
  ).run(flatRevision3);
  const maxAssignment = insertAssignment(fixture, {
    caseId: caseOne, feeItemId: maxSafeFee, agreementId: flatAgreement,
    formulaRevisionId: flatRevision3,
  });
  const maxRun = insertRun(fixture, {
    caseId: caseOne, feeItemId: maxSafeFee, kind: 'receipt', previewHash: 'max-safe-preview',
    baseFen: Number.MAX_SAFE_INTEGER, feeVersion: 1, targetStatus: 'paid', paidOn: '2026-11-03',
  });
  const maxFormula = `{"result_kind":"fixed","result_fixed_fen":${Number.MAX_SAFE_INTEGER},"deductions":[]}`;
  const maxTrace = `[{"step":"result","calculated_amount_fen":${Number.MAX_SAFE_INTEGER},"applied_amount_fen":${Number.MAX_SAFE_INTEGER},"clamped":false}]`;
  const maxSnapshot = insertSnapshot(fixture, {
    runId: maxRun, caseId: caseOne, feeItemId: maxSafeFee,
    agreementId: flatAgreement, revisionId: flatRevision3, assignmentId: maxAssignment,
    planVersion: 1, revisionChoice: 'initial', counterpart: '赵六',
    formulaJson: maxFormula, traceJson: maxTrace, baseFen: Number.MAX_SAFE_INTEGER,
    desiredFen: Number.MAX_SAFE_INTEGER, closedFen: 0, newFen: Number.MAX_SAFE_INTEGER,
    entryKind: 'calculated', dueMonth: '2026-11',
  });
  assert.throws(() => fixture.prepare(
    `INSERT INTO fee_shares
       (case_id,agreement_id,fee_item_id,assignment_id,settlement_snapshot_id,entry_kind,
        direction,counterpart,base_amount,base_amount_fen,amount,amount_fen,due_month)
     VALUES (?,?,?,?,?,'calculated','payable','赵六',?,?,?,?, '2026-11')`
  ).run(
    caseOne, flatAgreement, maxSafeFee, maxAssignment, maxSnapshot,
    Number.MAX_SAFE_INTEGER / 100, Number.MAX_SAFE_INTEGER,
    1, Number.MAX_SAFE_INTEGER
  ), /deterministic engine fen projection/);
  const maxShare = insertEngineShare(fixture, {
    caseId: caseOne, agreementId: flatAgreement, feeItemId: maxSafeFee,
    assignmentId: maxAssignment, snapshotId: maxSnapshot, entryKind: 'calculated',
    counterpart: '赵六', baseFen: Number.MAX_SAFE_INTEGER,
    amountFen: Number.MAX_SAFE_INTEGER, dueMonth: '2026-11',
  });
  assert.deepEqual(fixture.prepare(
    'SELECT base_amount,base_amount_fen,amount,amount_fen FROM fee_shares WHERE id=?'
  ).get(maxShare), {
    base_amount: Number.MAX_SAFE_INTEGER / 100,
    base_amount_fen: Number.MAX_SAFE_INTEGER,
    amount: Number.MAX_SAFE_INTEGER / 100,
    amount_fen: Number.MAX_SAFE_INTEGER,
  });

  assert.deepEqual(fixture.pragma('foreign_key_check'), [], '完整性样例后 foreign_key_check 必须为空');
  assert.equal(fixture.pragma('integrity_check', { simple: true }), 'ok', '升级后 integrity_check 必须为 ok');

  // preflight：sub-cent legacy money/rate 都必须让整个 007 原子失败，不能生成矛盾 canonical 值。
  const subCentMoney = openDatabase('sub-cent-money.db');
  runMigrations(subCentMoney, legacyDir);
  const subCentCase = insertCase(subCentMoney, 'sub-cent 金额案');
  insertFee(subCentMoney, subCentCase, '三位小数', 1.001);
  assert.throws(() => runMigrations(subCentMoney, upgradeDir), /legacy_money_must_be_cent_exact|CHECK constraint/);
  assert.equal(subCentMoney.pragma('user_version', { simple: true }), 6);
  assert.equal(subCentMoney.prepare("SELECT 1 FROM pragma_table_info('fee_items') WHERE name='amount_fen'").get(), undefined);

  const subCentRate = openDatabase('sub-cent-rate.db');
  runMigrations(subCentRate, legacyDir);
  const subCentRateCase = insertCase(subCentRate, 'sub-cent 比例案');
  subCentRate.prepare(
    "INSERT INTO fee_share_agreements (case_id,direction,counterpart,rate) VALUES (?,'payable','张三',33.333)"
  ).run(subCentRateCase);
  assert.throws(() => runMigrations(subCentRate, upgradeDir), /legacy_rate_must_be_bps_exact|CHECK constraint/);
  assert.equal(subCentRate.pragma('user_version', { simple: true }), 6);
  assert.equal(subCentRate.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fee_share_formula_revisions'").get(), undefined);

  // 真实 007 末尾附加故障：ALTER/CREATE/回填与 user_version 必须一起回滚。
  const failureDir = path.join(scratchDir, 'migrations-007-failure');
  copyMigrations(failureDir, MIGRATIONS_001_006);
  fs.writeFileSync(
    path.join(failureDir, MIGRATION_007),
    `${fs.readFileSync(path.join(migrationsDir, MIGRATION_007), 'utf8')}\nTHIS IS INVALID SQL;\n`
  );
  const failing = openDatabase('atomic-007.db');
  runMigrations(failing, legacyDir);
  const failingCase = insertCase(failing, '原子回滚示例案');
  failing.prepare(
    "INSERT INTO fee_share_agreements (case_id,direction,counterpart,rate) VALUES (?,'payable','张三',50)"
  ).run(failingCase);
  assert.throws(() => runMigrations(failing, failureDir), /near "THIS"|syntax error/i);
  assert.equal(failing.pragma('user_version', { simple: true }), 6);
  assert.equal(failing.prepare("SELECT 1 FROM pragma_table_info('fee_items') WHERE name='amount_fen'").get(), undefined);
  assert.equal(failing.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fee_share_formula_revisions'").get(), undefined);
  assert.equal(failing.prepare('SELECT COUNT(*) AS count FROM fee_share_agreements').get().count, 1);
  assert.deepEqual(failing.pragma('foreign_key_check'), []);

  console.log('migration 007 tests: legacy preservation + canonical money + sealed revisions + assignments + lineage + snapshots + ledger guards + atomic rollback all passed');
} finally {
  for (const db of databases) {
    if (db.open) db.close();
  }
  if (bootstrap?.open) bootstrap.close();
  fs.rmSync(scratchDir, { recursive: true, force: true });
}
