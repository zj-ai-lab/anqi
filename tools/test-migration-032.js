import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';
const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db);
assert.equal(db.pragma('user_version', { simple: true }), 32);
assert.throws(() => db.prepare("INSERT INTO im_bindings(provider,userid,bot_id,bound_at) VALUES ('bad','x','y','z')").run());
db.prepare("INSERT INTO im_inbound(provider,msgid,received_at,outcome) VALUES ('wecom','m1','2099-01-01T00:00:00Z','ignored')").run();
assert.throws(() => db.prepare("INSERT INTO im_inbound(provider,msgid,received_at,outcome) VALUES ('wecom','m1','2099-01-01T00:00:00Z','ignored')").run(), /UNIQUE/);
console.log('migration 032: binding and inbound dedup schema passed'); db.close();
