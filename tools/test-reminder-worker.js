import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';
import { createReminderWorker } from '../src/lib/reminder-worker.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-rworker-'));
const db = new Database(path.join(dir, 'worker.db')); db.pragma('foreign_keys=ON'); runMigrations(db);
const now = new Date('2099-11-03T00:00:00.000Z');
const insert = db.prepare(`INSERT INTO reminders (origin,tier,title,fire_at,version,status,created_at,updated_at) VALUES ('manual','manual',?,?,1,'scheduled',?,?)`);
const stamp = now.toISOString();
insert.run('in', '2099-11-02T23:30:00.000Z', stamp, stamp);
insert.run('late', '2099-11-01T00:00:00.000Z', stamp, stamp);
const worker = createReminderWorker({ db, catchupMinutes: 60, now: () => now });
await worker.tick();
assert.equal(db.prepare("SELECT status FROM reminders WHERE title='in'").get().status, 'fired');
assert.equal(db.prepare("SELECT status_reason FROM reminders WHERE title='late'").get().status_reason, 'window_expired');
assert.equal(db.prepare('SELECT COUNT(*) c FROM reminder_deliveries').get().c, 1);
await worker.tick(); assert.equal(db.prepare('SELECT COUNT(*) c FROM reminder_deliveries').get().c, 1);
db.prepare("UPDATE reminders SET status='sending' WHERE title='in'").run();
worker.start(); await worker.stop();
assert.equal(db.prepare("SELECT status_reason FROM reminders WHERE title='in'").get().status_reason, 'crash_recovery');
console.log('reminder worker: catch-up, missed, delivery uniqueness, and crash recovery passed');
db.close(); fs.rmSync(dir, { recursive: true, force: true });

const boomDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-rworker-boom-'));
const boomDb = new Database(path.join(boomDir, 'worker.db')); boomDb.pragma('foreign_keys=ON'); runMigrations(boomDb);
boomDb.prepare(`INSERT INTO reminders (origin,tier,title,fire_at,version,status,created_at,updated_at) VALUES ('manual','manual','boom','2099-11-02T23:30:00.000Z',1,'scheduled',?,?)`).run(stamp, stamp);
const boomWorker = createReminderWorker({
  db: boomDb,
  catchupMinutes: 60,
  now: () => now,
  channels: [{ id: 'boom', label: 'x', configured: () => true, deliver: async () => { throw new Error('boom'); } }],
});
await boomWorker.tick();
const boomDelivery = boomDb.prepare('SELECT * FROM reminder_deliveries').get();
assert.equal(boomDelivery.status, 'failed'); assert.match(boomDelivery.detail, /boom/);
assert.equal(boomDb.prepare("SELECT status FROM reminders WHERE title='boom'").get().status, 'fired');
await boomWorker.tick(); assert.equal(boomDb.prepare('SELECT COUNT(*) c FROM reminder_deliveries').get().c, 1);
boomDb.close(); fs.rmSync(boomDir, { recursive: true, force: true });

const batchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-rworker-batch-'));
const batchDb = new Database(path.join(batchDir, 'worker.db')); batchDb.pragma('foreign_keys=ON'); runMigrations(batchDb);
const batchInsert = batchDb.prepare(`INSERT INTO reminders (origin,tier,title,fire_at,version,status,created_at,updated_at) VALUES ('manual','manual',?,'2099-11-02T23:30:00.000Z',1,'scheduled',?,?)`);
for (let i = 0; i < 60; i++) batchInsert.run(`batch-${i}`, stamp, stamp);
const batchWorker = createReminderWorker({ db: batchDb, catchupMinutes: 60, now: () => now });
await batchWorker.tick();
assert.equal(batchDb.prepare("SELECT COUNT(*) c FROM reminders WHERE status='fired'").get().c, 50);
assert.equal(batchDb.prepare("SELECT COUNT(*) c FROM reminders WHERE status='scheduled'").get().c, 10);
await batchWorker.tick();
assert.equal(batchDb.prepare("SELECT COUNT(*) c FROM reminders WHERE status='fired'").get().c, 60);
assert.equal(batchDb.prepare('SELECT COUNT(*) c FROM reminder_deliveries').get().c, 60);
batchDb.close(); fs.rmSync(batchDir, { recursive: true, force: true });

const expiryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-rworker-expiry-'));
const expiryDb = new Database(path.join(expiryDir, 'worker.db')); expiryDb.pragma('foreign_keys=ON'); runMigrations(expiryDb);
const expiryStamp = '2099-11-02T01:00:00.000Z';
const reminderId = expiryDb.prepare(`INSERT INTO reminders (origin,tier,title,fire_at,version,status,created_at,updated_at) VALUES ('manual','manual','expiry','2099-11-01T00:00:00.000Z',1,'fired',?,?)`).run(expiryStamp, expiryStamp).lastInsertRowid;
const deliveryInsert = expiryDb.prepare(`INSERT INTO reminder_deliveries (reminder_id,reminder_version,channel,delivery_key,status,attempted_at,updated_at) VALUES (?,?,?,?,'queued',?,?)`);
deliveryInsert.run(reminderId, 1, 'inapp', `${reminderId}:1:inapp`, '2099-11-01T00:00:00.000Z', expiryStamp);
deliveryInsert.run(reminderId, 1, 'inapp', `${reminderId}:1:inapp-late`, '2099-11-01T02:00:00.000Z', expiryStamp);
const expiryWorker = createReminderWorker({ db: expiryDb, now: () => new Date(expiryStamp) });
await expiryWorker.tick();
const expiryRows = expiryDb.prepare('SELECT status,attempted_at FROM reminder_deliveries ORDER BY id').all();
assert.equal(expiryRows[0].status, 'expired'); assert.equal(expiryRows[1].status, 'queued');
console.log('reminder worker: channel failure, 50-item claim limit, and queued expiry passed');
expiryDb.close(); fs.rmSync(expiryDir, { recursive: true, force: true });
