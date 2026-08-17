// migration 010：v9 → v10，验证稳定结算时间、暂定公式元数据与原子回滚。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsDir = path.join(root, 'src', 'migrations');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-migration-010-'));
const files9 = fs.readdirSync(migrationsDir).filter((name) => /^00[1-9]_.*\.sql$/.test(name)).sort();
const files10 = fs.readdirSync(migrationsDir).filter((name) => /^(00[1-9]|010)_.*\.sql$/.test(name)).sort();

function copy(files, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(migrationsDir, file), path.join(target, file));
}

const dir9 = path.join(scratch, 'v9');
const dir10 = path.join(scratch, 'v10');
copy(files9, dir9);
copy(files10, dir10);

const db = new Database(path.join(scratch, 'fixture.db'));
db.pragma('foreign_keys=ON');
runMigrations(db, dir9);
const caseId = db.prepare(
  "INSERT INTO cases (name,procedure,stage) VALUES ('张三诉李四合同纠纷（迁移测试）','一审','审理中')"
).run().lastInsertRowid;
const agreementId = db.prepare(
  `INSERT INTO fee_share_agreements (case_id,direction,counterpart,rate,note)
   VALUES (?,'receivable','王律师',25,'暂按25%，税费和律所费用待确定')`
).run(caseId).lastInsertRowid;
const revisionId = db.prepare(
  `INSERT INTO fee_share_formula_revisions
     (agreement_id,case_id,revision_no,effective_on,label,change_note,
      result_kind,result_basis,result_rate_bps,created_by)
   VALUES (?,?,1,'2026-07-01','暂定二成五','先记暂定比例','rate','gross',2500,'test')`
).run(agreementId, caseId).lastInsertRowid;
db.prepare(
  "UPDATE fee_share_formula_revisions SET sealed=1,sealed_at='2026-07-01 00:00:00',sealed_by='test' WHERE id=?"
).run(revisionId);
const fixedAgreementId = db.prepare(
  `INSERT INTO fee_share_agreements (case_id,direction,counterpart,flat_amount,note)
   VALUES (?,'payable','赵律师',500,'暂定固定额，待双方签字')`
).run(caseId).lastInsertRowid;
const fixedRevisionId = db.prepare(
  `INSERT INTO fee_share_formula_revisions
     (agreement_id,case_id,revision_no,effective_on,label,change_note,
      result_kind,result_fixed_fen,created_by)
   VALUES (?,?,1,'2026-07-01','暂定固定额','暂定金额待签字','fixed',50000,'test')`
).run(fixedAgreementId, caseId).lastInsertRowid;
db.prepare(
  "UPDATE fee_share_formula_revisions SET sealed=1,sealed_at='2026-07-01 00:00:00',sealed_by='test' WHERE id=?"
).run(fixedRevisionId);

runMigrations(db, dir10);
assert.equal(db.pragma('user_version', { simple: true }), 10);
assert.equal(
  db.prepare('SELECT settlement_term FROM fee_share_agreements WHERE id=?').get(agreementId).settlement_term,
  '待确定'
);
assert.deepEqual(
  db.prepare('SELECT is_provisional,pending_deductions FROM fee_share_formula_revisions WHERE id=?').get(revisionId),
  { is_provisional: 1, pending_deductions: '税费、律所费用' }
);
assert.deepEqual(
  db.prepare('SELECT is_provisional,pending_deductions FROM fee_share_formula_revisions WHERE id=?').get(fixedRevisionId),
  { is_provisional: 0, pending_deductions: '' },
  '文字含“暂定”的固定额旧公式不得被迁移成暂定比例'
);
assert.throws(
  () => db.prepare('UPDATE fee_share_formula_revisions SET is_provisional=2 WHERE id=?').run(revisionId),
  /immutable|CHECK constraint/
);
db.close();

const failingDir = path.join(scratch, 'failure');
copy(files9, failingDir);
fs.writeFileSync(
  path.join(failingDir, '010_share_human_terms.sql'),
  `${fs.readFileSync(path.join(migrationsDir, '010_share_human_terms.sql'), 'utf8')}\nTHIS IS INVALID SQL;\n`
);
const failing = new Database(path.join(scratch, 'failing.db'));
runMigrations(failing, dir9);
assert.throws(() => runMigrations(failing, failingDir), /near "THIS"|syntax error/i);
assert.equal(failing.pragma('user_version', { simple: true }), 9);
assert.equal(
  failing.prepare("SELECT 1 FROM pragma_table_info('fee_share_agreements') WHERE name='settlement_term'").get(),
  undefined
);
failing.close();

fs.rmSync(scratch, { recursive: true, force: true });
console.log('migration 010 tests: v9 preservation + human terms + atomic rollback passed');
