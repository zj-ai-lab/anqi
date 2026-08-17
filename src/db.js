import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'anjian.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const migDir = path.join(__dirname, 'migrations');

// 每个 migration 文件是一个原子单元：DDL/DML 与 user_version 要么一起提交，要么一起回滚。
// migration SQL 不得自带 BEGIN/COMMIT；SQLite 的 DDL 可纳入 better-sqlite3 transaction。
export function runMigrations(targetDb, migrationDir = migDir) {
  const files = fs.readdirSync(migrationDir).filter((f) => f.endsWith('.sql')).sort();
  let version = targetDb.pragma('user_version', { simple: true });
  const apply = targetDb.transaction((sql, number) => {
    targetDb.exec(sql);
    targetDb.pragma(`user_version = ${number}`);
  });

  for (const f of files) {
    const number = parseInt(f.slice(0, 3), 10);
    if (number > version) {
      apply(fs.readFileSync(path.join(migrationDir, f), 'utf8'), number);
      version = number;
    }
  }
}

runMigrations(db);

// 节假日表装载（幂等）：rules/holidays-<year>.json → holidays 表。
// 数据源纪律：文件只能从国务院办公厅当年通知逐日核对后灌入（见各文件 _comment）。
const rulesDir = path.join(__dirname, '..', 'rules');
const upsertHoliday = db.prepare('INSERT OR REPLACE INTO holidays (date, kind) VALUES (?, ?)');
for (const f of fs.readdirSync(rulesDir).filter((x) => /^holidays-\d{4}\.json$/.test(x))) {
  const doc = JSON.parse(fs.readFileSync(path.join(rulesDir, f), 'utf8'));
  const load = db.transaction((days) => {
    for (const d of days) upsertHoliday.run(d.date, d.kind);
  });
  load(doc.days || []);
}

let nestedTransactionSequence = 0;

export function withImmediateTransaction(work) {
  if (db.inTransaction) {
    const savepoint = `anjian_nested_${++nestedTransactionSequence}`;
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = work();
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } catch { /* Preserve the original application error. */ }
      throw error;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* BEGIN itself may have failed. */ }
    throw error;
  }
}

export function audit(actor, action, entity, entityId, detail = '') {
  db.prepare(
    'INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)'
  ).run(actor, action, entity, entityId ?? null, String(detail).slice(0, 500));
}
