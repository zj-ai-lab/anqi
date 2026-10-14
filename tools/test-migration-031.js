import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anqi-m031-'));
try {
  for (const withExisting of [false, true]) {
    const db = new Database(path.join(dir, `${withExisting ? 'existing' : 'empty'}.db`));
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    assert.ok(db.pragma('user_version', { simple: true }) >= 31, 'migration 031 remains applied before later migrations');
    if (withExisting) {
      const caseId = db.prepare("INSERT INTO cases (name) VALUES ('张三案')").run().lastInsertRowid;
      db.prepare("INSERT INTO worklog (case_id,worked_on,content) VALUES (?,?,?)").run(caseId, '2099-01-01', '存量日志');
      assert.equal(db.prepare('SELECT created_by FROM worklog').get().created_by, 'manual');
    }
    const caseId = db.prepare("INSERT INTO cases (name) VALUES ('李四案')").run().lastInsertRowid;
    const beforeInsert = db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity='worklog' AND action='insert'").get().n;
    const inserted = db.prepare("INSERT INTO worklog (case_id,worked_on,content,created_by) VALUES (?,?,?,?)").run(caseId, '2099-01-02', 'AI 日志', 'ai');
    const afterInsert = db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity='worklog' AND action='insert'").get().n;
    assert.equal(afterInsert - beforeInsert, 1);
    assert.throws(() => db.prepare("INSERT INTO worklog (case_id,worked_on,content,created_by) VALUES (?,?,?,?)").run(caseId, '2099-01-03', '坏来源', 'llm'), /CHECK/);
    const before = db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity='worklog'").get().n;
    const id = inserted.lastInsertRowid;
    db.prepare('DELETE FROM worklog WHERE id=?').run(id);
    const after = db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity='worklog'").get().n;
    assert.equal(after - before, 1);
    db.close();
  }
  console.log('migration 031: worklog created_by defaults/check/trigger preservation passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
