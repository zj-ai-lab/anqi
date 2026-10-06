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

// 变更记录（R7 · migration 022）的身份上下文。
//
// migration 022 用触发器把 cases/events/deadlines/tasks/worklog 的每一次增删改写进
// change_log；触发器读不到应用层变量，只能读一张单行表 change_context。这里就是
// 往那张表写身份的三个函数。
//
// 三条纪律：
//   ① 上下文写、业务写、上下文清空必须同事务 —— 事务提交后上下文必然归零，所以
//      不存在「上一个请求的 actor 泄漏给下一条写入路径」的可能（这也是它不做成
//      Express 中间件的原因：中间件无法与业务写同事务，异步路由一让出就是错配）；
//   ② 没被包过的写入（后台 bridge tick、migration 回填、临时脚本）落到触发器的
//      system 回落值，记为 actor='system' —— 是「如实记成不知道谁改的」，不是漏记；
//   ③ 本函数是 withImmediateTransaction 的「带身份」变体，不另立事务模型，
//      嵌套调用照旧走 SAVEPOINT。
export function setChangeContext({ actor = 'system', origin = 'local', rule_id = null } = {}) {
  db.prepare(
    `INSERT INTO change_context (id, actor, origin, rule_id) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET actor = excluded.actor, origin = excluded.origin, rule_id = excluded.rule_id`
  ).run(actor, origin, rule_id);
}

export function clearChangeContext() {
  db.prepare("UPDATE change_context SET actor = NULL, origin = 'local', rule_id = NULL WHERE id = 1").run();
}

// 只补 rule_id、不动 actor。给「一次调用按多条规则派生」的地方用（engine.js 的
// deriveForEvent / applyRecalc）：那些函数在调用方的事务里跑，逐条规则换个 rule_id
// 就够了，actor 属于调用方的事务边界，不该在这里被重设——重设会在调用方没包上下文时
// 把 actor 遗留在表里，害到下一条不相干的写入。
export function setChangeRuleId(ruleId) {
  db.prepare('UPDATE change_context SET rule_id = ? WHERE id = 1').run(ruleId ?? null);
}

export function withChangeContext(options, work) {
  return withImmediateTransaction(() => {
    setChangeContext(options);
    try {
      return work();
    } finally {
      clearChangeContext();
    }
  });
}

export function audit(actor, action, entity, entityId, detail = '') {
  db.prepare(
    'INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)'
  ).run(actor, action, entity, entityId ?? null, String(detail).slice(0, 500));
}
