// 生成 src/migrations/024_change_log.sql
// 为什么用脚本而不是手写：5 张表共 79 列，手写 79 行 UNION ALL 列比对极易漏列；
// 从 PRAGMA table_info 读真实表结构生成，列清单与库永远一致（本次列清单快照日 2026-09-12）。
// 用法：node tools/gen-024-change-log.mjs > /tmp/024.sql  （再人工核对后落盘）
// 注意：本脚本只读表结构，不写库；不 import db.js（那会真的跑迁移）。
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dir = mkdtempSync(path.join(tmpdir(), 'anqi-gen024-'));
const db = new Database(path.join(dir, 'schema.db'));
db.pragma('foreign_keys = ON');
const migDir = path.join(process.cwd(), 'src/migrations');
const apply = db.transaction((sql, n) => { db.exec(sql); db.pragma('user_version = ' + n); });
let v = 0;
for (const f of readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
  const n = parseInt(f.slice(0, 3), 10);
  if (n >= 24) continue;                       // 只重放到 023，表结构即为 024 之前的形态
  if (n > v) { apply(readFileSync(path.join(migDir, f), 'utf8'), n); v = n; }
}

// 每张表：entity 名 + 人类可读标签列（insert 落 new_value、delete 落 old_value）
const TABLES = [
  { table: 'cases', cn: '案件', entity: 'case', label: 'name', caseIdOf: (p) => `${p}.id` },
  { table: 'events', cn: '事件', entity: 'event', label: 'type', caseIdOf: (p) => `${p}.case_id` },
  { table: 'deadlines', cn: '期限', entity: 'deadline', label: 'name', caseIdOf: (p) => `${p}.case_id` },
  { table: 'tasks', cn: '待办', entity: 'task', label: 'title', caseIdOf: (p) => `${p}.case_id` },
  { table: 'worklog', cn: '工作日志', entity: 'worklog', label: 'content', caseIdOf: (p) => `${p}.case_id` },
];

// worklog.content 可能上千字：底账留标签，不留全文（全文在业务表里，别把底账撑肿）
const labelExpr = (t, p) => (
  t === 'worklog' ? `substr(${p}.content, 1, 120)` : `${p}.${t === 'events' ? 'type' : TABLES.find((x) => x.table === t).label}`
);

const ctxOrigin = "COALESCE((SELECT origin FROM change_context WHERE id=1),'local')";
const ctxActor = "COALESCE((SELECT actor FROM change_context WHERE id=1),'system')";
const ctxRule = '(SELECT rule_id FROM change_context WHERE id=1)';

const out = [];
const P = (s = '') => out.push(s);

P('-- 024: 本地审计底账。五张核心业务表由触发器记录增删改，保留删除后的案件归属。');
P('-- 更新按字段记录，忽略 id/updated_at；插入/删除保留人类可读标签。');
P('-- withChangeContext 与业务写入同事务；未提供上下文时使用 system/local。');
P('-- 本迁移不回填历史。025 补 case_type，026 扩展联系人、参与人和财务审计。');
P('-- change_log 只追加；原 PR 的 synced_at/origin 元数据保留兼容，无同步实现。');
P('');
P('CREATE TABLE IF NOT EXISTS change_log (');
P('  id         INTEGER PRIMARY KEY AUTOINCREMENT,');
P('  entity     TEXT NOT NULL,                      -- case | event | deadline | task | worklog');
P('  entity_id  INTEGER,');
P('  case_id    INTEGER,                            -- 该行所属案件；tasks/worklog 可为 NULL');
P('  action     TEXT NOT NULL CHECK (action IN (\'insert\',\'update\',\'delete\')),');
P('  field      TEXT,                               -- update 为被改字段名；insert/delete 为 NULL');
P('  old_value  TEXT,                               -- delete 放人类可读标签；update 放旧值');
P('  new_value  TEXT,                               -- insert 放人类可读标签；update 放新值');
P('  changed_at TEXT NOT NULL DEFAULT (datetime(\'now\',\'+8 hours\')),');
P('  origin     TEXT NOT NULL DEFAULT \'local\' CHECK (origin IN (\'local\',\'cloud\')),');
P('  actor      TEXT,                               -- 去个人化角色（见 013）：web / ai / system …');
P('  rule_id    TEXT,                               -- 由规则派生引起时记规则 id，可回溯「为什么是这个日期」');
P('  synced_at  TEXT                                -- 保留的来源元数据；本地写入为 NULL');
P(');');
P('');
P('-- 案件详情页按案件倒序取最近变更（主用索引）');
P('CREATE INDEX IF NOT EXISTS idx_change_log_case ON change_log (case_id, id DESC);');
P('CREATE INDEX IF NOT EXISTS idx_change_log_entity ON change_log (entity, entity_id, id DESC);');
P('-- 保留来源元数据索引（没有同步器）');
P('CREATE INDEX IF NOT EXISTS idx_change_log_unsynced ON change_log (id) WHERE synced_at IS NULL;');
P('');
P('-- 事务内上下文：单行表（CHECK id=1）。空表或字段为 NULL 时触发器回落 system/local。');
P('CREATE TABLE IF NOT EXISTS change_context (');
P('  id      INTEGER PRIMARY KEY CHECK (id = 1),');
P('  actor   TEXT,');
P('  origin  TEXT DEFAULT \'local\',');
P('  rule_id TEXT');
P(');');
P('');
P('-- 不可变保护：底账只增不改。trigger 之外还要挡住直接 SQL。');
P('CREATE TRIGGER IF NOT EXISTS trg_change_log_no_update');
P('BEFORE UPDATE ON change_log');
P('BEGIN');
P('  SELECT RAISE(ABORT, \'change_log is append-only\');');
P('END;');
P('');
P('CREATE TRIGGER IF NOT EXISTS trg_change_log_no_delete');
P('BEFORE DELETE ON change_log');
P('BEGIN');
P('  SELECT RAISE(ABORT, \'change_log is append-only\');');
P('END;');
P('');

for (const { table, cn, entity, caseIdOf } of TABLES) {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name);
  const diffCols = cols.filter((c) => c !== 'id' && c !== 'updated_at');
  const label = labelExpr(table, 'NEW');
  const oldLabel = labelExpr(table, 'OLD');

  P('');
  P(`-- ---------- ${cn} ${table}（${cols.length} 列，UPDATE 逐列比对 ${diffCols.length} 列）----------`);

  // insert
  P(`CREATE TRIGGER IF NOT EXISTS trg_log_${table}_insert AFTER INSERT ON ${table}`);
  P('BEGIN');
  P('  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)');
  P(`  VALUES ('${entity}', NEW.id, ${caseIdOf('NEW')}, 'insert', NULL, NULL, CAST(${label} AS TEXT), ${ctxOrigin}, ${ctxActor}, ${ctxRule});`);
  P('END;');
  P('');

  // delete
  P(`CREATE TRIGGER IF NOT EXISTS trg_log_${table}_delete AFTER DELETE ON ${table}`);
  P('BEGIN');
  P('  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)');
  P(`  VALUES ('${entity}', OLD.id, ${caseIdOf('OLD')}, 'delete', NULL, CAST(${oldLabel} AS TEXT), NULL, ${ctxOrigin}, ${ctxActor}, ${ctxRule});`);
  P('END;');
  P('');

  // update
  P(`CREATE TRIGGER IF NOT EXISTS trg_log_${table}_update AFTER UPDATE ON ${table}`);
  P('BEGIN');
  P('  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)');
  P('  SELECT');
  P(`    '${entity}', NEW.id, ${caseIdOf('NEW')}, 'update', d.field, d.old_value, d.new_value,`);
  P(`    ${ctxOrigin}, ${ctxActor}, ${ctxRule}`);
  P('  FROM (');
  diffCols.forEach((c, i) => {
    const head = i === 0
      ? `    SELECT '${c}' AS field`
      : `    UNION ALL SELECT '${c}' AS field`;
    P(`${head}, CAST(OLD.${c} AS TEXT) AS old_value, CAST(NEW.${c} AS TEXT) AS new_value WHERE OLD.${c} IS NOT NEW.${c}`);
  });
  P('  ) d;');
  P('END;');
}

P('');
db.close();
rmSync(dir, { recursive: true, force: true });
process.stdout.write(out.join('\n'));
