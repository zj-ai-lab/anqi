// migration 009：从真实 v8 fixture 升级，保全既有业务数据，并验证原子回滚。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsDir = path.join(root, 'src', 'migrations');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-migration-009-'));
const files8 = fs.readdirSync(migrationsDir).filter((name) => /^00[1-8]_.*\.sql$/.test(name)).sort();
const files9 = fs.readdirSync(migrationsDir).filter((name) => /^00[1-9]_.*\.sql$/.test(name)).sort();

function copy(files, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(migrationsDir, file), path.join(target, file));
}

const dir8 = path.join(scratch, 'v8');
const dir9 = path.join(scratch, 'v9');
copy(files8, dir8);
copy(files9, dir9);

const db = new Database(path.join(scratch, 'fixture.db'));
db.pragma('foreign_keys=ON');
runMigrations(db, dir8);
assert.equal(db.pragma('user_version', { simple: true }), 8);
const caseId = db.prepare(
  "INSERT INTO cases (name,procedure,stage) VALUES ('张三诉李四合同纠纷（迁移测试）','一审','审理中')"
).run().lastInsertRowid;
const feeId = db.prepare(
  "INSERT INTO fee_items (case_id,label,amount,amount_fen) VALUES (?,'签约款',1000,100000)"
).run(caseId).lastInsertRowid;

runMigrations(db, dir9);
assert.equal(db.pragma('user_version', { simple: true }), 9, '升级后应为 user_version=9');
assert.deepEqual(
  db.prepare('SELECT id,label,amount_fen FROM fee_items WHERE id=?').get(feeId),
  { id: feeId, label: '签约款', amount_fen: 100000 },
  'migration 不得改既有费用事实'
);
for (const table of [
  'legalrag_case_links', 'legalrag_files', 'legalrag_extractions',
  'legalrag_candidates', 'legalrag_bridge_meta',
]) {
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), `${table} 应存在`);
}
assert.throws(
  () => db.prepare(
    "INSERT INTO legalrag_files (case_id,rel_path,filename,revision,sync_status) VALUES (?,?,?,?,?)"
  ).run(caseId, '法院文书/a.pdf', 'a.pdf', 1, 'not-a-status'),
  /CHECK constraint failed/
);
const bridgeFileId = db.prepare(
  "INSERT INTO legalrag_files (case_id,rel_path,filename,revision) VALUES (?,?,?,1)"
).run(caseId, '法院文书/候选.pdf', '候选.pdf').lastInsertRowid;
const extractionId = db.prepare(
  "INSERT INTO legalrag_extractions (file_id,extractor,schema_version) VALUES (?,'test',1)"
).run(bridgeFileId).lastInsertRowid;
assert.throws(
  () => db.prepare(
    "INSERT INTO legalrag_candidates (extraction_id,file_id,case_id,kind,payload) VALUES (?,?,?,'task','{}')"
  ).run(extractionId, bridgeFileId, caseId),
  /CHECK constraint failed/
);
db.close();

const failingDir = path.join(scratch, 'failure');
copy(files8, failingDir);
fs.writeFileSync(
  path.join(failingDir, '009_legalrag_file_bridge.sql'),
  `${fs.readFileSync(path.join(migrationsDir, '009_legalrag_file_bridge.sql'), 'utf8')}\nTHIS IS INVALID SQL;\n`
);
const failing = new Database(path.join(scratch, 'failing.db'));
runMigrations(failing, dir8);
assert.throws(() => runMigrations(failing, failingDir), /near "THIS"|syntax error/i);
assert.equal(failing.pragma('user_version', { simple: true }), 8, '失败 migration 不得推进版本');
assert.equal(
  failing.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legalrag_files'").get(),
  undefined,
  '失败 migration 的表必须回滚'
);
failing.close();

fs.rmSync(scratch, { recursive: true, force: true });
console.log('migration 009 tests: v8 preservation + bridge schema + atomic rollback passed');
