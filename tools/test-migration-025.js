// migration 025：case_type 列 + 触发器；回填只认 刑事*/行政* 前缀，一审/二审保持未分类。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsDir = path.join(root, 'src', 'migrations');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-migration-025-'));
const files24 = fs.readdirSync(migrationsDir).filter((name) => /^(00[1-9]|01[0-9]|02[0-4])_.*\.sql$/.test(name)).sort();
const files25 = fs.readdirSync(migrationsDir).filter((name) => /^(00[1-9]|01[0-9]|02[0-5])_.*\.sql$/.test(name)).sort();

function copy(files, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(migrationsDir, file), path.join(target, file));
}
const dir24 = path.join(scratch, 'v24');
const dir25 = path.join(scratch, 'v25');
copy(files24, dir24);
copy(files25, dir25);

if (!process.env.DB_PATH) process.env.DB_PATH = path.join(scratch, 'guard.db');
const { runMigrations } = await import('../src/db.js');

const db = new Database(path.join(scratch, 'fixture.db'));
db.pragma('foreign_keys = ON');
runMigrations(db, dir24);
assert.equal(db.pragma('user_version', { simple: true }), 24);

const ins = db.prepare("INSERT INTO cases (name, procedure, stage) VALUES (?, ?, '审理中')");
const idCivil1 = ins.run('回填一审', '一审').lastInsertRowid;
const idCivil2 = ins.run('回填二审', '二审').lastInsertRowid;
const idCr = ins.run('回填刑一', '刑事一审').lastInsertRowid;
const idAd = ins.run('回填行一', '行政一审').lastInsertRowid;
const idNs = ins.run('回填非诉', '非诉').lastInsertRowid;

runMigrations(db, dir25);
assert.equal(db.pragma('user_version', { simple: true }), 25);

const types = Object.fromEntries(
  db.prepare('SELECT id, case_type FROM cases WHERE id IN (?,?,?,?,?)').all(idCivil1, idCivil2, idCr, idAd, idNs)
    .map((r) => [r.id, r.case_type])
);
assert.equal(types[idCivil1], '未分类', '一审不得自动映为民事');
assert.equal(types[idCivil2], '未分类', '二审不得自动映为民事');
assert.equal(types[idCr], '刑事');
assert.equal(types[idAd], '行政');
assert.equal(types[idNs], '未分类');

db.prepare("UPDATE cases SET case_type='民事' WHERE id=?").run(idCivil1);
const log = db.prepare("SELECT field, old_value, new_value FROM change_log WHERE entity='case' AND entity_id=? AND field='case_type'").get(idCivil1);
assert.equal(log?.old_value, '未分类');
assert.equal(log?.new_value, '民事');

db.close();
console.log('PASS: migration 025 case_type column, prefix-only backfill, change_log trigger');
