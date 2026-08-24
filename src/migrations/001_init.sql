-- anjian 001: 初始 8 表（docs/DESIGN.md §2）
-- 时间一律存北京时间 naive 字符串：日期 'YYYY-MM-DD'，时刻 'YYYY-MM-DD HH:MM:SS'

CREATE TABLE cases (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,        -- 人类可读案件标题
  case_no          TEXT NOT NULL DEFAULT '',
  cause            TEXT NOT NULL DEFAULT '',
  court            TEXT NOT NULL DEFAULT '',
  client           TEXT NOT NULL DEFAULT '',
  client_role      TEXT NOT NULL DEFAULT '',
  opponent         TEXT NOT NULL DEFAULT '',
  procedure        TEXT NOT NULL DEFAULT '一审',
  stage            TEXT NOT NULL DEFAULT '',
  stage_entered_at TEXT NOT NULL DEFAULT (date('now','+8 hours')),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','shelved','closed')),
  accepted_at      TEXT NOT NULL DEFAULT '',
  folder_path      TEXT NOT NULL DEFAULT '',    -- ANJIAN_FILES_ROOT 下的单层 workspace 名
  sol_starts_on    TEXT NOT NULL DEFAULT '',    -- 诉讼时效起算日（P1 引擎用，DESIGN Q2）
  note             TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);

-- 程序事件 = 期限触发器（D1）。occurred_on 允许未来日期（开庭排期）
CREATE TABLE events (
  id             INTEGER PRIMARY KEY,
  case_id        INTEGER NOT NULL REFERENCES cases(id),
  type           TEXT NOT NULL,
  occurred_on    TEXT NOT NULL,
  service_method TEXT NOT NULL DEFAULT '',      -- 送达方式，一等计算参数（D2，P1 引擎消费）
  instrument     TEXT NOT NULL DEFAULT '',      -- 文书依据
  note           TEXT NOT NULL DEFAULT '',
  created_by     TEXT NOT NULL DEFAULT 'manual' CHECK (created_by IN ('manual','llm','import')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX idx_events_case ON events(case_id, occurred_on);
CREATE INDEX idx_events_type ON events(type, occurred_on);

-- 法定死线。与 tasks.plan_date 语义严格分开（P4）
CREATE TABLE deadlines (
  id                 INTEGER PRIMARY KEY,
  case_id            INTEGER NOT NULL REFERENCES cases(id),
  name               TEXT NOT NULL,
  due_on             TEXT NOT NULL,
  trigger_event_id   INTEGER REFERENCES events(id),
  rule_id            TEXT NOT NULL DEFAULT '',  -- ''=手动；P1 起=deadline_rules.json 的 id
  basis              TEXT NOT NULL DEFAULT '',  -- 法律依据
  calc_note          TEXT NOT NULL DEFAULT '',  -- 算法说明，期限必须可审计
  is_manual_override INTEGER NOT NULL DEFAULT 0, -- 人工设定/修正 → 级联重算默认排除（D4）
  severity           TEXT NOT NULL DEFAULT 'normal' CHECK (severity IN ('critical','high','normal')),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','missed','waived')),
  done_at            TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX idx_deadlines_case ON deadlines(case_id, due_on);
CREATE INDEX idx_deadlines_status_due ON deadlines(status, due_on);

CREATE TABLE tasks (
  id          INTEGER PRIMARY KEY,
  case_id     INTEGER REFERENCES cases(id),    -- NULL = 所务/非案件
  title       TEXT NOT NULL,
  plan_date   TEXT NOT NULL DEFAULT '',        -- 计划开工日（软）
  due_on      TEXT NOT NULL DEFAULT '',        -- 任务自身硬到期（法定期限勿放这里）
  deadline_id INTEGER REFERENCES deadlines(id),
  stage       TEXT NOT NULL DEFAULT '',
  priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
  origin      TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','template','llm')),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped')),
  done_at     TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX idx_tasks_status ON tasks(status, plan_date, due_on);
CREATE INDEX idx_tasks_case ON tasks(case_id);

CREATE TABLE worklog (
  id         INTEGER PRIMARY KEY,
  case_id    INTEGER REFERENCES cases(id),     -- NULL = 所务
  worked_on  TEXT NOT NULL,
  content    TEXT NOT NULL,
  minutes    INTEGER,                          -- 可选，自我观察不做计费
  artifacts  TEXT NOT NULL DEFAULT '',         -- 产物指针（路径/URL）
  created_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX idx_worklog_case ON worklog(case_id, worked_on);
CREATE INDEX idx_worklog_date ON worklog(worked_on);

-- 收件箱（P1 Linear Triage）：非人工直录的对象先进这里，accept 才落正式表
CREATE TABLE inbox (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('event','deadline','task','note')),
  payload      TEXT NOT NULL,                  -- JSON：目标表预填字段
  source       TEXT NOT NULL,                  -- llm-extract|llm-suggest|quick-capture|import
  source_ref   TEXT NOT NULL DEFAULT '',       -- 原文出处指针，供对照确认
  case_id      INTEGER REFERENCES cases(id),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','snoozed')),
  snooze_until TEXT NOT NULL DEFAULT '',
  decided_at   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX idx_inbox_status ON inbox(status);

-- 节假日/调休（国务院年度安排；P1 编纂核对后灌入）
CREATE TABLE holidays (
  date TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('holiday','workday'))
);

CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY,
  at        TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  actor     TEXT NOT NULL,                     -- web|cli|internal|system（历史兼容值见 DESIGN）
  action    TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id INTEGER,
  detail    TEXT NOT NULL DEFAULT ''
);
