// migration 019 升级测试：v18 → v19，允许明确纳入本款的 receivable assignment / snapshot。
// 覆盖：旧守卫确实拒绝 receivable、升级后 assignment 与 receipt snapshot 放行、幂等与原子回滚。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsDir = path.join(root, 'src', 'migrations');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-migration-019-'));
const files18 = fs.readdirSync(migrationsDir).filter((name) => /^(00[1-9]|01[0-8])_.*\.sql$/.test(name)).sort();
const files19 = fs.readdirSync(migrationsDir).filter((name) => /^(00[1-9]|01[0-9])_.*\.sql$/.test(name)).sort();

function copy(files, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(migrationsDir, file), path.join(target, file));
}

const dir18 = path.join(scratch, 'v18');
const dir19 = path.join(scratch, 'v19');
copy(files18, dir18);
copy(files19, dir19);

function seedFixture(db) {
  const caseId = Number(db.prepare(
    `INSERT INTO cases (name, case_no, client, procedure, status)
     VALUES ('迁移双向示例案（张三）', '', '张三', '一审', 'active')`
  ).run().lastInsertRowid);
  const feeId = Number(db.prepare(
    `INSERT INTO fee_items (case_id, label, amount, node, due_on, status)
     VALUES (?, '一期律师费', 1000, '签约', '2026-09-23', 'unpaid')`
  ).run(caseId).lastInsertRowid);
  const agreementId = Number(db.prepare(
    `INSERT INTO fee_share_agreements
       (case_id, direction, counterpart, rate, flat_amount, note, status, version, updated_at)
     VALUES (?, 'receivable', '王五', 10, NULL, '', 'active', 1, '2026-09-23 09:00:00')`
  ).run(caseId).lastInsertRowid);
  const revisionId = Number(db.prepare(
    `INSERT INTO fee_share_formula_revisions
       (agreement_id, case_id, revision_no, effective_on, label, change_note,
        result_kind, result_basis, result_rate_bps, result_fixed_fen,
        created_by, created_at, sealed, sealed_at, sealed_by, is_provisional, pending_deductions)
     VALUES (?, ?, 1, '2026-09-23', '应收一成', '迁移测试',
        'rate', 'gross', 1000, NULL,
        'migration-test', '2026-09-23 09:00:00', 0, '', '', 0, '')`
  ).run(agreementId, caseId).lastInsertRowid);
  db.prepare(
    `UPDATE fee_share_formula_revisions
        SET sealed = 1, sealed_at = '2026-09-23 09:01:00', sealed_by = 'migration-test'
      WHERE id = ?`
  ).run(revisionId);
  return { caseId, feeId, agreementId, revisionId };
}

const db = new Database(path.join(scratch, 'fixture.db'));
db.pragma('foreign_keys = ON');
runMigrations(db, dir18);
assert.equal(db.pragma('user_version', { simple: true }), 18);
const fixture = seedFixture(db);

const assignmentValues = [
  fixture.caseId, fixture.feeId, fixture.agreementId, 'not_applicable', null,
  'not_applicable', '升级前应拒绝', 'migration-test', '2026-09-23 09:02:00',
  '2026-09-23 09:02:00', 1,
];
assert.throws(
  () => db.prepare(
    `INSERT INTO fee_share_assignments
       (case_id, fee_item_id, agreement_id, status, formula_revision_id, revision_choice,
        decision_note, decided_by, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(...assignmentValues),
  /active payable agreement/i,
);

runMigrations(db, dir19);
assert.equal(db.pragma('user_version', { simple: true }), 19);

const assignmentId = Number(db.prepare(
  `INSERT INTO fee_share_assignments
     (case_id, fee_item_id, agreement_id, status, formula_revision_id, revision_choice,
      decision_note, decided_by, created_at, updated_at, version)
   VALUES (?, ?, ?, 'assigned', ?, 'initial', '本款形成应收', 'migration-test',
      '2026-09-23 09:03:00', '2026-09-23 09:03:00', 1)`
).run(fixture.caseId, fixture.feeId, fixture.agreementId, fixture.revisionId).lastInsertRowid);

const runId = Number(db.prepare(
  `INSERT INTO fee_share_settlement_runs
     (case_id, fee_item_id, run_kind, request_id, preview_hash, preview_inputs_json,
      base_amount_fen, fee_version, target_status, paid_on, confirmed_by, confirmed_at)
   VALUES (?, ?, 'receipt', '', 'migration-019-preview', '{}', 100000, 1, 'paid',
      '2026-09-23', 'migration-test', '2026-09-23 09:04:00')`
).run(fixture.caseId, fixture.feeId).lastInsertRowid);

db.prepare(
  `INSERT INTO fee_share_settlement_snapshots
     (settlement_run_id, case_id, fee_item_id, agreement_id, formula_revision_id, assignment_id,
      plan_version, revision_choice, source_snapshot_id, direction, counterpart,
      formula_json, trace_json, base_amount_fen, desired_amount_fen, closed_amount_fen,
      new_amount_fen, entry_kind, due_month)
   VALUES (?, ?, ?, ?, ?, ?, 1, 'initial', NULL, 'receivable', '王五',
      '{"result_kind":"rate","result_basis":"gross","result_rate_bps":1000,"deductions":[]}',
      '[]', 100000, 10000, 0, 10000, 'calculated', '2026-09')`
).run(runId, fixture.caseId, fixture.feeId, fixture.agreementId, fixture.revisionId, assignmentId);

runMigrations(db, dir19);
assert.equal(db.pragma('user_version', { simple: true }), 19);
assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
assert.deepEqual(db.pragma('foreign_key_check'), []);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fee_share_settlement_snapshots').get().count, 1);
db.close();

const failingDir = path.join(scratch, 'failure');
copy(files18, failingDir);
fs.writeFileSync(
  path.join(failingDir, '019_bidirectional_fee_settlement.sql'),
  `${fs.readFileSync(path.join(migrationsDir, '019_bidirectional_fee_settlement.sql'), 'utf8')}\nTHIS IS INVALID SQL;\n`
);
const failing = new Database(path.join(scratch, 'failing.db'));
failing.pragma('foreign_keys = ON');
runMigrations(failing, dir18);
assert.throws(() => runMigrations(failing, failingDir), /near "THIS"|syntax error/i);
assert.equal(failing.pragma('user_version', { simple: true }), 18);
assert.equal(failing.prepare(
  "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_share_snapshot_validate_insert'"
).get().count, 1);
assert.equal(failing.pragma('integrity_check', { simple: true }), 'ok');
failing.close();

fs.rmSync(scratch, { recursive: true, force: true });
console.log('migration 019 tests: receivable assignment/snapshot + idempotent + atomic rollback passed');
