// migration 012：v11 → v12，验证旧款项保全、约束与原子回滚。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsDir = path.join(root, 'src', 'migrations');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-migration-012-'));
const files11 = fs.readdirSync(migrationsDir).filter((name) => /^(00[1-9]|01[01])_.*\.sql$/.test(name)).sort();
const files12 = fs.readdirSync(migrationsDir).filter((name) => /^(00[1-9]|01[0-2])_.*\.sql$/.test(name)).sort();

function copy(files, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(migrationsDir, file), path.join(target, file));
}

const dir11 = path.join(scratch, 'v11');
const dir12 = path.join(scratch, 'v12');
copy(files11, dir11);
copy(files12, dir12);

const fixture = new Database(path.join(scratch, 'fixture.db'));
fixture.pragma('foreign_keys=ON');
runMigrations(fixture, dir11);
const caseId = fixture.prepare(
  "INSERT INTO cases(name,procedure,stage) VALUES ('凭证迁移测试案','一审','审理中')"
).run().lastInsertRowid;
const feeId = fixture.prepare(
  "INSERT INTO fee_items(case_id,label,amount) VALUES (?,'签约款',5000)"
).run(caseId).lastInsertRowid;

runMigrations(fixture, dir12);
assert.equal(fixture.pragma('user_version', { simple: true }), 12);
assert.equal(fixture.prepare('SELECT label FROM fee_items WHERE id=?').get(feeId).label, '签约款');
const insert = fixture.prepare(
  `INSERT INTO fee_item_files(fee_item_id,case_id,rel_path,kind,size)
   VALUES (?,?,?,?,?)`
);
insert.run(feeId, caseId, '财务凭证/收款.pdf', 'receipt', 12);
assert.throws(
  () => insert.run(feeId, caseId, '财务凭证/收款.pdf', 'receipt', 12),
  /UNIQUE constraint/
);
assert.throws(
  () => insert.run(feeId, caseId, '财务凭证/非法.pdf', 'unknown', 12),
  /CHECK constraint/
);
assert.equal(fixture.pragma('integrity_check', { simple: true }), 'ok');
assert.deepEqual(fixture.pragma('foreign_key_check'), []);
fixture.close();

const failingDir = path.join(scratch, 'failure');
copy(files11, failingDir);
fs.writeFileSync(
  path.join(failingDir, '012_fee_item_files.sql'),
  `${fs.readFileSync(path.join(migrationsDir, '012_fee_item_files.sql'), 'utf8')}\nTHIS IS INVALID SQL;\n`
);
const failing = new Database(path.join(scratch, 'failing.db'));
runMigrations(failing, dir11);
assert.throws(() => runMigrations(failing, failingDir), /near "THIS"|syntax error/i);
assert.equal(failing.pragma('user_version', { simple: true }), 11);
assert.equal(
  failing.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fee_item_files'").get(),
  undefined
);
failing.close();

fs.rmSync(scratch, { recursive: true, force: true });
console.log('migration 012 tests: v11 preservation + voucher constraints + atomic rollback passed');
