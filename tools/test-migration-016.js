// migration 016 升级测试：v15 → v16，sessions 时间统一为 UTC。
// 覆盖：活跃 token 保留、UTC+8 初始值归一、已续期 UTC 值不误减、幂等与原子回滚。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationsDir = path.join(root, 'src', 'migrations');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-migration-016-'));
const files15 = fs.readdirSync(migrationsDir).filter((name) => /^(00[1-9]|01[0-5])_.*\.sql$/.test(name)).sort();
const files16 = fs.readdirSync(migrationsDir).filter((name) => /^(00[1-9]|01[0-6])_.*\.sql$/.test(name)).sort();

function copy(files, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(migrationsDir, file), path.join(target, file));
}

const dir15 = path.join(scratch, 'v15');
const dir16 = path.join(scratch, 'v16');
copy(files15, dir15);
copy(files16, dir16);

const db = new Database(path.join(scratch, 'fixture.db'));
db.pragma('foreign_keys = ON');
runMigrations(db, dir15);
assert.equal(db.pragma('user_version', { simple: true }), 15);

db.prepare('INSERT INTO sessions (token, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?)').run(
  'initial-token', '2026-08-17 16:00:00', '2026-09-16 08:00:00', '2026-08-17 16:00:00'
);
db.prepare('INSERT INTO sessions (token, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?)').run(
  'renewed-token', '2026-08-10 18:00:00', '2026-09-17 09:30:00', '2026-08-18 09:30:00'
);

runMigrations(db, dir16);
assert.equal(db.pragma('user_version', { simple: true }), 16);
assert.deepEqual(db.prepare('SELECT * FROM sessions WHERE token = ?').get('initial-token'), {
  token: 'initial-token',
  created_at: '2026-08-17 08:00:00',
  expires_at: '2026-09-16 08:00:00',
  last_seen: '2026-08-17 08:00:00',
});
assert.deepEqual(db.prepare('SELECT * FROM sessions WHERE token = ?').get('renewed-token'), {
  token: 'renewed-token',
  created_at: '2026-08-10 10:00:00',
  expires_at: '2026-09-17 09:30:00',
  last_seen: '2026-08-18 09:30:00',
});
const defaults = db.prepare(
  "SELECT name, dflt_value FROM pragma_table_info('sessions') WHERE name IN ('created_at','last_seen') ORDER BY name"
).all();
assert.deepEqual(defaults, [
  { name: 'created_at', dflt_value: "datetime('now')" },
  { name: 'last_seen', dflt_value: "datetime('now')" },
]);
db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').run('new-token', '2099-01-01 00:00:00');
const fresh = db.prepare('SELECT created_at, last_seen FROM sessions WHERE token = ?').get('new-token');
assert.equal(fresh.created_at, fresh.last_seen);
assert.equal(Math.abs(Date.parse(fresh.created_at.replace(' ', 'T') + 'Z') - Date.now()) < 5000, true);

runMigrations(db, dir16);
assert.equal(db.pragma('user_version', { simple: true }), 16);
assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
assert.deepEqual(db.pragma('foreign_key_check'), []);
db.close();

const failingDir = path.join(scratch, 'failure');
copy(files15, failingDir);
fs.writeFileSync(
  path.join(failingDir, '016_sessions_utc.sql'),
  `${fs.readFileSync(path.join(migrationsDir, '016_sessions_utc.sql'), 'utf8')}\nTHIS IS INVALID SQL;\n`
);
const failing = new Database(path.join(scratch, 'failing.db'));
failing.pragma('foreign_keys = ON');
runMigrations(failing, dir15);
failing.prepare('INSERT INTO sessions (token, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?)').run(
  'rollback-token', '2026-08-17 16:00:00', '2026-09-16 08:00:00', '2026-08-17 16:00:00'
);
assert.throws(() => runMigrations(failing, failingDir), /near "THIS"|syntax error/i);
assert.equal(failing.pragma('user_version', { simple: true }), 15);
assert.deepEqual(failing.prepare('SELECT * FROM sessions WHERE token = ?').get('rollback-token'), {
  token: 'rollback-token',
  created_at: '2026-08-17 16:00:00',
  expires_at: '2026-09-16 08:00:00',
  last_seen: '2026-08-17 16:00:00',
});
assert.equal(
  failing.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='sessions_v16'").get().count,
  0
);
failing.close();

fs.rmSync(scratch, { recursive: true, force: true });
console.log('migration 016 tests: UTC normalization + token preservation + idempotent + atomic rollback passed');
