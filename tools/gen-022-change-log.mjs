// 生成 src/migrations/022_change_log.sql
// 为什么用脚本而不是手写：5 张表共 79 列，手写 79 行 UNION ALL 列比对极易漏列；
// 从 PRAGMA table_info 读真实表结构生成，列清单与库永远一致（本次列清单快照日 2026-09-12）。
// 用法：node tools/gen-022-change-log.mjs > /tmp/022.sql  （再人工核对后落盘）
// 注意：本脚本只读表结构，不写库；不 import db.js（那会真的跑迁移）。
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dir = mkdtempSync(path.join(tmpdir(), 'anqi-gen022-'));
const db = new Database(path.join(dir, 'schema.db'));
db.pragma('foreign_keys = ON');
const migDir = path.join(process.cwd(), 'src/migrations');
const apply = db.transaction((sql, n) => { db.exec(sql); db.pragma('user_version = ' + n); });
let v = 0;
for (const f of readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
  const n = parseInt(f.slice(0, 3), 10);
  if (n >= 22) continue;                       // 只重放到 021，表结构即为 022 设计时的形态
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

P('-- 022_change_log.sql —— 变更记录（R7）：本地↔云端同步与追责的事实底账');
P('--');
P('-- 为什么要有这张表');
P('--   方案 §4.3：本地 SQLite 是单一事实源，云端（WorkBuddy 资料库）是投影。没有一份');
P('--   「谁在什么时候把哪个字段从什么改成了什么」的底账，同步就只能靠整表覆盖、出了');
P('--   冲突无从对账，人工在本地改过的期限也会在下一次上云时被悄悄抹平。');
P('--');
P('-- 为什么用触发器而不是在应用层逐处埋点');
P('--   写入路径不止 HTTP 一条：agent 直写、LegalRAG 候选采纳、阶段模板铺待办、定时');
P('--   任务都会动这五张表。应用层埋点必然漏，触发器在场即必然记录。');
P('--');
P('-- 上下文（actor / origin / rule_id）从哪来');
P('--   触发器读不到应用层变量，用一个单行表 change_context 传递。db.js 的');
P('--   withChangeContext() 在同一事务内先写上下文、再执行业务写、最后清空上下文——');
P('--   清空与业务写同事务，事务提交后必然归零，所以不存在「上一个请求的 actor 泄漏');
P('--   给另一路径」的可能。未经该包装的写入（后台 bridge tick 等）一律记 actor=\'system\'。');
P('--');
P('-- 为什么要有 case_id（与方案 §4.3 原字段表相比多出的一列）');
P('--   案件详情页要把「本案的期限被谁从哪天改到哪天」摆出来，而 change_log 里');
P('--   entity=\'deadline\' 的行只有那个期限自己的 id；光靠 entity+entity_id 反查不到');
P('--   「它属于哪个案件」，更要命的是：期限被删掉之后，反查的源行没了，这条删除记录');
P('--   会从案件页彻底消失——恰恰是最需要看到的那一类。所以由触发器在写入时就把');
P('--   case_id 一起落下来（cases 取自身主键，其余四表取各自 case_id 列，可空）。');
P('--');
P('-- 为什么 insert/delete 也带一个「值」');
P('--   update 有明确的 field + old/new。insert 没有单个字段可指，delete 之后源行又没了；');
P('--   若两者都只记 id，底账读起来就是「新增了一条期限」而不知是哪条。故约定：');
P('--     · insert → new_value 放该行的人类可读标签（cases.name / events.type /');
P('--       deadlines.name / tasks.title / worklog.content 前 120 字）');
P('--     · delete → old_value 放同一标签（源行已删，这是唯一还留着名字的地方）');
P('--   标签存的是原始词表值（如 events.type=\'served\'），中文呈现由前端按 /api/meta 翻译；');
P('--   底账记事实、前端管呈现，不把展示文案焊死进历史数据。');
P('--');
P('-- 不可变');
P('--   change_log 追加写、只读：UPDATE / DELETE 一律 RAISE(ABORT)。参照 010 的');
P('--   fee_share_formula_revisions 不可变范式。要更正错误就再记一条，不改历史。');
P('--');
P('-- 覆盖面与已知边界');
P('--   覆盖 cases / events / deadlines / tasks / worklog 五张业务表。分账域（fee_*）、');
P('--   audit_log、contacts、facts、节假日表不在本表范围内（方案 §4.6「不上云」清单）。');
P('--   UPDATE 差异按列展开，列清单生成于 2026-09-12 的真实表结构；后续若给这五张表');
P('--   ALTER ADD COLUMN，需同步补 023 往 trg_log_*_update 里加一列比对（新增列不会');
P('--   自动被记录，这是刻意的取舍：宁可记全，不可虚记）。');
P('--   id / updated_at 不进差异：主键不会变，updated_at 是纯记账列，记它只会把');
P('--   「其实什么都没改」的写入也弄成一条变更。');
P('--');
P('-- 迁移纪律：本文件不得自带 BEGIN/COMMIT（db.js 的 runMigrations 已在事务内包裹）。');
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
P('  synced_at  TEXT                                -- 上云时刻；未上云为 NULL');
P(');');
P('');
P('-- 案件详情页按案件倒序取最近变更（主用索引）');
P('CREATE INDEX IF NOT EXISTS idx_change_log_case ON change_log (case_id, id DESC);');
P('CREATE INDEX IF NOT EXISTS idx_change_log_entity ON change_log (entity, entity_id, id DESC);');
P('-- 阶段 6 同步器「还有哪些没上云」的部分索引');
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
