// migration 017 升级测试：v16 → v17，把历史案件的隐式同名目录物化为稳定 workspace 指针。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsDir = path.join(root, 'src', 'migrations');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-migration-017-'));
const files16 = fs.readdirSync(migrationsDir).filter((name) => /^(00[1-9]|01[0-6])_.*\.sql$/.test(name)).sort();
const files17 = fs.readdirSync(migrationsDir).filter((name) => /^(00[1-9]|01[0-7])_.*\.sql$/.test(name)).sort();

function copy(files, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(migrationsDir, file), path.join(target, file));
}

const dir16 = path.join(scratch, 'v16');
const dir17 = path.join(scratch, 'v17');
copy(files16, dir16);
copy(files17, dir17);

const db = new Database(path.join(scratch, 'fixture.db'));
db.pragma('foreign_keys = ON');
runMigrations(db, dir16);
db.prepare("INSERT INTO cases (name,folder_path) VALUES ('历史同名案','')").run();
db.prepare("INSERT INTO cases (name,folder_path) VALUES ('已单独绑定案','既有同步目录')").run();

runMigrations(db, dir17);
assert.equal(db.pragma('user_version', { simple: true }), 17);
assert.deepEqual(db.prepare('SELECT name,folder_path FROM cases ORDER BY id').all(), [
  { name: '历史同名案', folder_path: '历史同名案' },
  { name: '已单独绑定案', folder_path: '既有同步目录' },
]);
runMigrations(db, dir17);
assert.equal(db.pragma('user_version', { simple: true }), 17);
assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
db.close();

const failingDir = path.join(scratch, 'failure');
copy(files16, failingDir);
fs.writeFileSync(
  path.join(failingDir, '017_case_workspaces.sql'),
  `${fs.readFileSync(path.join(migrationsDir, '017_case_workspaces.sql'), 'utf8')}\nTHIS IS INVALID SQL;\n`,
);
const failing = new Database(path.join(scratch, 'failing.db'));
runMigrations(failing, dir16);
failing.prepare("INSERT INTO cases (name,folder_path) VALUES ('回滚案','')").run();
assert.throws(() => runMigrations(failing, failingDir), /near "THIS"|syntax error/i);
assert.equal(failing.pragma('user_version', { simple: true }), 16);
assert.equal(failing.prepare("SELECT folder_path FROM cases WHERE name='回滚案'").get().folder_path, '');
failing.close();

fs.rmSync(scratch, { recursive: true, force: true });
console.log('migration 017 tests: legacy workspace materialization + preservation + idempotent + atomic rollback passed');
