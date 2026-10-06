-- 022_change_log.sql —— 变更记录（R7）：本地↔云端同步与追责的事实底账
--
-- 为什么要有这张表
--   方案 §4.3：本地 SQLite 是单一事实源，云端（WorkBuddy 资料库）是投影。没有一份
--   「谁在什么时候把哪个字段从什么改成了什么」的底账，同步就只能靠整表覆盖、出了
--   冲突无从对账，人工在本地改过的期限也会在下一次上云时被悄悄抹平。
--
-- 为什么用触发器而不是在应用层逐处埋点
--   写入路径不止 HTTP 一条：agent 直写、LegalRAG 候选采纳、阶段模板铺待办、定时
--   任务都会动这五张表。应用层埋点必然漏，触发器在场即必然记录。
--
-- 上下文（actor / origin / rule_id）从哪来
--   触发器读不到应用层变量，用一个单行表 change_context 传递。db.js 的
--   withChangeContext() 在同一事务内先写上下文、再执行业务写、最后清空上下文——
--   清空与业务写同事务，事务提交后必然归零，所以不存在「上一个请求的 actor 泄漏
--   给另一路径」的可能。未经该包装的写入（后台 bridge tick 等）一律记 actor='system'。
--
-- 为什么要有 case_id（与方案 §4.3 原字段表相比多出的一列）
--   案件详情页要把「本案的期限被谁从哪天改到哪天」摆出来，而 change_log 里
--   entity='deadline' 的行只有那个期限自己的 id；光靠 entity+entity_id 反查不到
--   「它属于哪个案件」，更要命的是：期限被删掉之后，反查的源行没了，这条删除记录
--   会从案件页彻底消失——恰恰是最需要看到的那一类。所以由触发器在写入时就把
--   case_id 一起落下来（cases 取自身主键，其余四表取各自 case_id 列，可空）。
--
-- 为什么 insert/delete 也带一个「值」
--   update 有明确的 field + old/new。insert 没有单个字段可指，delete 之后源行又没了；
--   若两者都只记 id，底账读起来就是「新增了一条期限」而不知是哪条。故约定：
--     · insert → new_value 放该行的人类可读标签（cases.name / events.type /
--       deadlines.name / tasks.title / worklog.content 前 120 字）
--     · delete → old_value 放同一标签（源行已删，这是唯一还留着名字的地方）
--   标签存的是原始词表值（如 events.type='served'），中文呈现由前端按 /api/meta 翻译；
--   底账记事实、前端管呈现，不把展示文案焊死进历史数据。
--
-- 不可变
--   change_log 追加写、只读：UPDATE / DELETE 一律 RAISE(ABORT)。参照 010 的
--   fee_share_formula_revisions 不可变范式。要更正错误就再记一条，不改历史。
--
-- 覆盖面与已知边界
--   覆盖 cases / events / deadlines / tasks / worklog 五张业务表。分账域（fee_*）、
--   audit_log、contacts、facts、节假日表不在本表范围内（方案 §4.6「不上云」清单）。
--   UPDATE 差异按列展开，列清单生成于 2026-09-12 的真实表结构；后续若给这五张表
--   ALTER ADD COLUMN，需同步补 023 往 trg_log_*_update 里加一列比对（新增列不会
--   自动被记录，这是刻意的取舍：宁可记全，不可虚记）。
--   id / updated_at 不进差异：主键不会变，updated_at 是纯记账列，记它只会把
--   「其实什么都没改」的写入也弄成一条变更。
--
-- 迁移纪律：本文件不得自带 BEGIN/COMMIT（db.js 的 runMigrations 已在事务内包裹）。

CREATE TABLE IF NOT EXISTS change_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity     TEXT NOT NULL,                      -- case | event | deadline | task | worklog
  entity_id  INTEGER,
  case_id    INTEGER,                            -- 该行所属案件；tasks/worklog 可为 NULL
  action     TEXT NOT NULL CHECK (action IN ('insert','update','delete')),
  field      TEXT,                               -- update 为被改字段名；insert/delete 为 NULL
  old_value  TEXT,                               -- delete 放人类可读标签；update 放旧值
  new_value  TEXT,                               -- insert 放人类可读标签；update 放新值
  changed_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  origin     TEXT NOT NULL DEFAULT 'local' CHECK (origin IN ('local','cloud')),
  actor      TEXT,                               -- 去个人化角色（见 013）：web / ai / system …
  rule_id    TEXT,                               -- 由规则派生引起时记规则 id，可回溯「为什么是这个日期」
  synced_at  TEXT                                -- 上云时刻；未上云为 NULL
);

-- 案件详情页按案件倒序取最近变更（主用索引）
CREATE INDEX IF NOT EXISTS idx_change_log_case ON change_log (case_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_change_log_entity ON change_log (entity, entity_id, id DESC);
-- 阶段 6 同步器「还有哪些没上云」的部分索引
CREATE INDEX IF NOT EXISTS idx_change_log_unsynced ON change_log (id) WHERE synced_at IS NULL;

-- 事务内上下文：单行表（CHECK id=1）。空表或字段为 NULL 时触发器回落 system/local。
CREATE TABLE IF NOT EXISTS change_context (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  actor   TEXT,
  origin  TEXT DEFAULT 'local',
  rule_id TEXT
);

-- 不可变保护：底账只增不改。trigger 之外还要挡住直接 SQL。
CREATE TRIGGER IF NOT EXISTS trg_change_log_no_update
BEFORE UPDATE ON change_log
BEGIN
  SELECT RAISE(ABORT, 'change_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_change_log_no_delete
BEFORE DELETE ON change_log
BEGIN
  SELECT RAISE(ABORT, 'change_log is append-only');
END;


-- ---------- 案件 cases（29 列，UPDATE 逐列比对 27 列）----------
CREATE TRIGGER IF NOT EXISTS trg_log_cases_insert AFTER INSERT ON cases
BEGIN
  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)
  VALUES ('case', NEW.id, NEW.id, 'insert', NULL, NULL, CAST(NEW.name AS TEXT), COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_cases_delete AFTER DELETE ON cases
BEGIN
  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)
  VALUES ('case', OLD.id, OLD.id, 'delete', NULL, CAST(OLD.name AS TEXT), NULL, COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_cases_update AFTER UPDATE ON cases
BEGIN
  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)
  SELECT
    'case', NEW.id, NEW.id, 'update', d.field, d.old_value, d.new_value,
    COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1)
  FROM (
    SELECT 'name' AS field, CAST(OLD.name AS TEXT) AS old_value, CAST(NEW.name AS TEXT) AS new_value WHERE OLD.name IS NOT NEW.name
    UNION ALL SELECT 'case_no' AS field, CAST(OLD.case_no AS TEXT) AS old_value, CAST(NEW.case_no AS TEXT) AS new_value WHERE OLD.case_no IS NOT NEW.case_no
    UNION ALL SELECT 'cause' AS field, CAST(OLD.cause AS TEXT) AS old_value, CAST(NEW.cause AS TEXT) AS new_value WHERE OLD.cause IS NOT NEW.cause
    UNION ALL SELECT 'court' AS field, CAST(OLD.court AS TEXT) AS old_value, CAST(NEW.court AS TEXT) AS new_value WHERE OLD.court IS NOT NEW.court
    UNION ALL SELECT 'client' AS field, CAST(OLD.client AS TEXT) AS old_value, CAST(NEW.client AS TEXT) AS new_value WHERE OLD.client IS NOT NEW.client
    UNION ALL SELECT 'client_role' AS field, CAST(OLD.client_role AS TEXT) AS old_value, CAST(NEW.client_role AS TEXT) AS new_value WHERE OLD.client_role IS NOT NEW.client_role
    UNION ALL SELECT 'opponent' AS field, CAST(OLD.opponent AS TEXT) AS old_value, CAST(NEW.opponent AS TEXT) AS new_value WHERE OLD.opponent IS NOT NEW.opponent
    UNION ALL SELECT 'procedure' AS field, CAST(OLD.procedure AS TEXT) AS old_value, CAST(NEW.procedure AS TEXT) AS new_value WHERE OLD.procedure IS NOT NEW.procedure
    UNION ALL SELECT 'stage' AS field, CAST(OLD.stage AS TEXT) AS old_value, CAST(NEW.stage AS TEXT) AS new_value WHERE OLD.stage IS NOT NEW.stage
    UNION ALL SELECT 'stage_entered_at' AS field, CAST(OLD.stage_entered_at AS TEXT) AS old_value, CAST(NEW.stage_entered_at AS TEXT) AS new_value WHERE OLD.stage_entered_at IS NOT NEW.stage_entered_at
    UNION ALL SELECT 'status' AS field, CAST(OLD.status AS TEXT) AS old_value, CAST(NEW.status AS TEXT) AS new_value WHERE OLD.status IS NOT NEW.status
    UNION ALL SELECT 'accepted_at' AS field, CAST(OLD.accepted_at AS TEXT) AS old_value, CAST(NEW.accepted_at AS TEXT) AS new_value WHERE OLD.accepted_at IS NOT NEW.accepted_at
    UNION ALL SELECT 'folder_path' AS field, CAST(OLD.folder_path AS TEXT) AS old_value, CAST(NEW.folder_path AS TEXT) AS new_value WHERE OLD.folder_path IS NOT NEW.folder_path
    UNION ALL SELECT 'sol_starts_on' AS field, CAST(OLD.sol_starts_on AS TEXT) AS old_value, CAST(NEW.sol_starts_on AS TEXT) AS new_value WHERE OLD.sol_starts_on IS NOT NEW.sol_starts_on
    UNION ALL SELECT 'note' AS field, CAST(OLD.note AS TEXT) AS old_value, CAST(NEW.note AS TEXT) AS new_value WHERE OLD.note IS NOT NEW.note
    UNION ALL SELECT 'created_at' AS field, CAST(OLD.created_at AS TEXT) AS old_value, CAST(NEW.created_at AS TEXT) AS new_value WHERE OLD.created_at IS NOT NEW.created_at
    UNION ALL SELECT 'legalrag_url' AS field, CAST(OLD.legalrag_url AS TEXT) AS old_value, CAST(NEW.legalrag_url AS TEXT) AS new_value WHERE OLD.legalrag_url IS NOT NEW.legalrag_url
    UNION ALL SELECT 'crime_type' AS field, CAST(OLD.crime_type AS TEXT) AS old_value, CAST(NEW.crime_type AS TEXT) AS new_value WHERE OLD.crime_type IS NOT NEW.crime_type
    UNION ALL SELECT 'trial_mode' AS field, CAST(OLD.trial_mode AS TEXT) AS old_value, CAST(NEW.trial_mode AS TEXT) AS new_value WHERE OLD.trial_mode IS NOT NEW.trial_mode
    UNION ALL SELECT 'case_nature' AS field, CAST(OLD.case_nature AS TEXT) AS old_value, CAST(NEW.case_nature AS TEXT) AS new_value WHERE OLD.case_nature IS NOT NEW.case_nature
    UNION ALL SELECT 'custody_status' AS field, CAST(OLD.custody_status AS TEXT) AS old_value, CAST(NEW.custody_status AS TEXT) AS new_value WHERE OLD.custody_status IS NOT NEW.custody_status
    UNION ALL SELECT 'case_side' AS field, CAST(OLD.case_side AS TEXT) AS old_value, CAST(NEW.case_side AS TEXT) AS new_value WHERE OLD.case_side IS NOT NEW.case_side
    UNION ALL SELECT 'entrust_stage' AS field, CAST(OLD.entrust_stage AS TEXT) AS old_value, CAST(NEW.entrust_stage AS TEXT) AS new_value WHERE OLD.entrust_stage IS NOT NEW.entrust_stage
    UNION ALL SELECT 'co_counsel' AS field, CAST(OLD.co_counsel AS TEXT) AS old_value, CAST(NEW.co_counsel AS TEXT) AS new_value WHERE OLD.co_counsel IS NOT NEW.co_counsel
    UNION ALL SELECT 'contract_no' AS field, CAST(OLD.contract_no AS TEXT) AS old_value, CAST(NEW.contract_no AS TEXT) AS new_value WHERE OLD.contract_no IS NOT NEW.contract_no
    UNION ALL SELECT 'custody_place' AS field, CAST(OLD.custody_place AS TEXT) AS old_value, CAST(NEW.custody_place AS TEXT) AS new_value WHERE OLD.custody_place IS NOT NEW.custody_place
    UNION ALL SELECT 'handling_agency' AS field, CAST(OLD.handling_agency AS TEXT) AS old_value, CAST(NEW.handling_agency AS TEXT) AS new_value WHERE OLD.handling_agency IS NOT NEW.handling_agency
  ) d;
END;

-- ---------- 事件 events（9 列，UPDATE 逐列比对 8 列）----------
CREATE TRIGGER IF NOT EXISTS trg_log_events_insert AFTER INSERT ON events
BEGIN
  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)
  VALUES ('event', NEW.id, NEW.case_id, 'insert', NULL, NULL, CAST(NEW.type AS TEXT), COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_events_delete AFTER DELETE ON events
BEGIN
  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)
  VALUES ('event', OLD.id, OLD.case_id, 'delete', NULL, CAST(OLD.type AS TEXT), NULL, COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_events_update AFTER UPDATE ON events
BEGIN
  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)
  SELECT
    'event', NEW.id, NEW.case_id, 'update', d.field, d.old_value, d.new_value,
    COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1)
  FROM (
    SELECT 'case_id' AS field, CAST(OLD.case_id AS TEXT) AS old_value, CAST(NEW.case_id AS TEXT) AS new_value WHERE OLD.case_id IS NOT NEW.case_id
    UNION ALL SELECT 'type' AS field, CAST(OLD.type AS TEXT) AS old_value, CAST(NEW.type AS TEXT) AS new_value WHERE OLD.type IS NOT NEW.type
    UNION ALL SELECT 'occurred_on' AS field, CAST(OLD.occurred_on AS TEXT) AS old_value, CAST(NEW.occurred_on AS TEXT) AS new_value WHERE OLD.occurred_on IS NOT NEW.occurred_on
    UNION ALL SELECT 'service_method' AS field, CAST(OLD.service_method AS TEXT) AS old_value, CAST(NEW.service_method AS TEXT) AS new_value WHERE OLD.service_method IS NOT NEW.service_method
    UNION ALL SELECT 'instrument' AS field, CAST(OLD.instrument AS TEXT) AS old_value, CAST(NEW.instrument AS TEXT) AS new_value WHERE OLD.instrument IS NOT NEW.instrument
    UNION ALL SELECT 'note' AS field, CAST(OLD.note AS TEXT) AS old_value, CAST(NEW.note AS TEXT) AS new_value WHERE OLD.note IS NOT NEW.note
    UNION ALL SELECT 'created_by' AS field, CAST(OLD.created_by AS TEXT) AS old_value, CAST(NEW.created_by AS TEXT) AS new_value WHERE OLD.created_by IS NOT NEW.created_by
    UNION ALL SELECT 'created_at' AS field, CAST(OLD.created_at AS TEXT) AS old_value, CAST(NEW.created_at AS TEXT) AS new_value WHERE OLD.created_at IS NOT NEW.created_at
  ) d;
END;

-- ---------- 期限 deadlines（20 列，UPDATE 逐列比对 19 列）----------
CREATE TRIGGER IF NOT EXISTS trg_log_deadlines_insert AFTER INSERT ON deadlines
BEGIN
  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)
  VALUES ('deadline', NEW.id, NEW.case_id, 'insert', NULL, NULL, CAST(NEW.name AS TEXT), COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_deadlines_delete AFTER DELETE ON deadlines
BEGIN
  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)
  VALUES ('deadline', OLD.id, OLD.case_id, 'delete', NULL, CAST(OLD.name AS TEXT), NULL, COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_deadlines_update AFTER UPDATE ON deadlines
BEGIN
  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)
  SELECT
    'deadline', NEW.id, NEW.case_id, 'update', d.field, d.old_value, d.new_value,
    COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1)
  FROM (
    SELECT 'case_id' AS field, CAST(OLD.case_id AS TEXT) AS old_value, CAST(NEW.case_id AS TEXT) AS new_value WHERE OLD.case_id IS NOT NEW.case_id
    UNION ALL SELECT 'name' AS field, CAST(OLD.name AS TEXT) AS old_value, CAST(NEW.name AS TEXT) AS new_value WHERE OLD.name IS NOT NEW.name
    UNION ALL SELECT 'due_on' AS field, CAST(OLD.due_on AS TEXT) AS old_value, CAST(NEW.due_on AS TEXT) AS new_value WHERE OLD.due_on IS NOT NEW.due_on
    UNION ALL SELECT 'trigger_event_id' AS field, CAST(OLD.trigger_event_id AS TEXT) AS old_value, CAST(NEW.trigger_event_id AS TEXT) AS new_value WHERE OLD.trigger_event_id IS NOT NEW.trigger_event_id
    UNION ALL SELECT 'rule_id' AS field, CAST(OLD.rule_id AS TEXT) AS old_value, CAST(NEW.rule_id AS TEXT) AS new_value WHERE OLD.rule_id IS NOT NEW.rule_id
    UNION ALL SELECT 'basis' AS field, CAST(OLD.basis AS TEXT) AS old_value, CAST(NEW.basis AS TEXT) AS new_value WHERE OLD.basis IS NOT NEW.basis
    UNION ALL SELECT 'calc_note' AS field, CAST(OLD.calc_note AS TEXT) AS old_value, CAST(NEW.calc_note AS TEXT) AS new_value WHERE OLD.calc_note IS NOT NEW.calc_note
    UNION ALL SELECT 'is_manual_override' AS field, CAST(OLD.is_manual_override AS TEXT) AS old_value, CAST(NEW.is_manual_override AS TEXT) AS new_value WHERE OLD.is_manual_override IS NOT NEW.is_manual_override
    UNION ALL SELECT 'severity' AS field, CAST(OLD.severity AS TEXT) AS old_value, CAST(NEW.severity AS TEXT) AS new_value WHERE OLD.severity IS NOT NEW.severity
    UNION ALL SELECT 'status' AS field, CAST(OLD.status AS TEXT) AS old_value, CAST(NEW.status AS TEXT) AS new_value WHERE OLD.status IS NOT NEW.status
    UNION ALL SELECT 'done_at' AS field, CAST(OLD.done_at AS TEXT) AS old_value, CAST(NEW.done_at AS TEXT) AS new_value WHERE OLD.done_at IS NOT NEW.done_at
    UNION ALL SELECT 'created_at' AS field, CAST(OLD.created_at AS TEXT) AS old_value, CAST(NEW.created_at AS TEXT) AS new_value WHERE OLD.created_at IS NOT NEW.created_at
    UNION ALL SELECT 'review_status' AS field, CAST(OLD.review_status AS TEXT) AS old_value, CAST(NEW.review_status AS TEXT) AS new_value WHERE OLD.review_status IS NOT NEW.review_status
    UNION ALL SELECT 'created_by' AS field, CAST(OLD.created_by AS TEXT) AS old_value, CAST(NEW.created_by AS TEXT) AS new_value WHERE OLD.created_by IS NOT NEW.created_by
    UNION ALL SELECT 'manual_days' AS field, CAST(OLD.manual_days AS TEXT) AS old_value, CAST(NEW.manual_days AS TEXT) AS new_value WHERE OLD.manual_days IS NOT NEW.manual_days
    UNION ALL SELECT 'manual_unit' AS field, CAST(OLD.manual_unit AS TEXT) AS old_value, CAST(NEW.manual_unit AS TEXT) AS new_value WHERE OLD.manual_unit IS NOT NEW.manual_unit
    UNION ALL SELECT 'manual_count_from' AS field, CAST(OLD.manual_count_from AS TEXT) AS old_value, CAST(NEW.manual_count_from AS TEXT) AS new_value WHERE OLD.manual_count_from IS NOT NEW.manual_count_from
    UNION ALL SELECT 'manual_roll' AS field, CAST(OLD.manual_roll AS TEXT) AS old_value, CAST(NEW.manual_roll AS TEXT) AS new_value WHERE OLD.manual_roll IS NOT NEW.manual_roll
    UNION ALL SELECT 'override_reason' AS field, CAST(OLD.override_reason AS TEXT) AS old_value, CAST(NEW.override_reason AS TEXT) AS new_value WHERE OLD.override_reason IS NOT NEW.override_reason
  ) d;
END;

-- ---------- 待办 tasks（14 列，UPDATE 逐列比对 13 列）----------
CREATE TRIGGER IF NOT EXISTS trg_log_tasks_insert AFTER INSERT ON tasks
BEGIN
  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)
  VALUES ('task', NEW.id, NEW.case_id, 'insert', NULL, NULL, CAST(NEW.title AS TEXT), COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_tasks_delete AFTER DELETE ON tasks
BEGIN
  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)
  VALUES ('task', OLD.id, OLD.case_id, 'delete', NULL, CAST(OLD.title AS TEXT), NULL, COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_tasks_update AFTER UPDATE ON tasks
BEGIN
  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)
  SELECT
    'task', NEW.id, NEW.case_id, 'update', d.field, d.old_value, d.new_value,
    COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1)
  FROM (
    SELECT 'case_id' AS field, CAST(OLD.case_id AS TEXT) AS old_value, CAST(NEW.case_id AS TEXT) AS new_value WHERE OLD.case_id IS NOT NEW.case_id
    UNION ALL SELECT 'title' AS field, CAST(OLD.title AS TEXT) AS old_value, CAST(NEW.title AS TEXT) AS new_value WHERE OLD.title IS NOT NEW.title
    UNION ALL SELECT 'plan_date' AS field, CAST(OLD.plan_date AS TEXT) AS old_value, CAST(NEW.plan_date AS TEXT) AS new_value WHERE OLD.plan_date IS NOT NEW.plan_date
    UNION ALL SELECT 'due_on' AS field, CAST(OLD.due_on AS TEXT) AS old_value, CAST(NEW.due_on AS TEXT) AS new_value WHERE OLD.due_on IS NOT NEW.due_on
    UNION ALL SELECT 'deadline_id' AS field, CAST(OLD.deadline_id AS TEXT) AS old_value, CAST(NEW.deadline_id AS TEXT) AS new_value WHERE OLD.deadline_id IS NOT NEW.deadline_id
    UNION ALL SELECT 'stage' AS field, CAST(OLD.stage AS TEXT) AS old_value, CAST(NEW.stage AS TEXT) AS new_value WHERE OLD.stage IS NOT NEW.stage
    UNION ALL SELECT 'priority' AS field, CAST(OLD.priority AS TEXT) AS old_value, CAST(NEW.priority AS TEXT) AS new_value WHERE OLD.priority IS NOT NEW.priority
    UNION ALL SELECT 'origin' AS field, CAST(OLD.origin AS TEXT) AS old_value, CAST(NEW.origin AS TEXT) AS new_value WHERE OLD.origin IS NOT NEW.origin
    UNION ALL SELECT 'status' AS field, CAST(OLD.status AS TEXT) AS old_value, CAST(NEW.status AS TEXT) AS new_value WHERE OLD.status IS NOT NEW.status
    UNION ALL SELECT 'done_at' AS field, CAST(OLD.done_at AS TEXT) AS old_value, CAST(NEW.done_at AS TEXT) AS new_value WHERE OLD.done_at IS NOT NEW.done_at
    UNION ALL SELECT 'note' AS field, CAST(OLD.note AS TEXT) AS old_value, CAST(NEW.note AS TEXT) AS new_value WHERE OLD.note IS NOT NEW.note
    UNION ALL SELECT 'created_at' AS field, CAST(OLD.created_at AS TEXT) AS old_value, CAST(NEW.created_at AS TEXT) AS new_value WHERE OLD.created_at IS NOT NEW.created_at
    UNION ALL SELECT 'due_time' AS field, CAST(OLD.due_time AS TEXT) AS old_value, CAST(NEW.due_time AS TEXT) AS new_value WHERE OLD.due_time IS NOT NEW.due_time
  ) d;
END;

-- ---------- 工作日志 worklog（7 列，UPDATE 逐列比对 6 列）----------
CREATE TRIGGER IF NOT EXISTS trg_log_worklog_insert AFTER INSERT ON worklog
BEGIN
  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)
  VALUES ('worklog', NEW.id, NEW.case_id, 'insert', NULL, NULL, CAST(substr(NEW.content, 1, 120) AS TEXT), COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_worklog_delete AFTER DELETE ON worklog
BEGIN
  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)
  VALUES ('worklog', OLD.id, OLD.case_id, 'delete', NULL, CAST(substr(OLD.content, 1, 120) AS TEXT), NULL, COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_worklog_update AFTER UPDATE ON worklog
BEGIN
  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)
  SELECT
    'worklog', NEW.id, NEW.case_id, 'update', d.field, d.old_value, d.new_value,
    COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1)
  FROM (
    SELECT 'case_id' AS field, CAST(OLD.case_id AS TEXT) AS old_value, CAST(NEW.case_id AS TEXT) AS new_value WHERE OLD.case_id IS NOT NEW.case_id
    UNION ALL SELECT 'worked_on' AS field, CAST(OLD.worked_on AS TEXT) AS old_value, CAST(NEW.worked_on AS TEXT) AS new_value WHERE OLD.worked_on IS NOT NEW.worked_on
    UNION ALL SELECT 'content' AS field, CAST(OLD.content AS TEXT) AS old_value, CAST(NEW.content AS TEXT) AS new_value WHERE OLD.content IS NOT NEW.content
    UNION ALL SELECT 'minutes' AS field, CAST(OLD.minutes AS TEXT) AS old_value, CAST(NEW.minutes AS TEXT) AS new_value WHERE OLD.minutes IS NOT NEW.minutes
    UNION ALL SELECT 'artifacts' AS field, CAST(OLD.artifacts AS TEXT) AS old_value, CAST(NEW.artifacts AS TEXT) AS new_value WHERE OLD.artifacts IS NOT NEW.artifacts
    UNION ALL SELECT 'created_at' AS field, CAST(OLD.created_at AS TEXT) AS old_value, CAST(NEW.created_at AS TEXT) AS new_value WHERE OLD.created_at IS NOT NEW.created_at
  ) d;
END;
