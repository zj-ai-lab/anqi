-- 021: cases 表新增四个刑事维度字段（供 deadline_rules_criminal.json 的 applies 多维过滤使用）
--
-- 背景：刑事期限规则的适用条件是多维的（同一条"提请批捕"规则，普通案件 3 日、
--       流窜/多次/结伙作案 30 日）。引擎按 cases 表的列值判定规则是否适用。
--       列不存在时引擎走 APPLIES_DEFAULT 兜底（一律按最保守的默认值），
--       条件型规则会只走默认分支。
--
-- 取值约定（与 rules/deadline_rules_criminal.json 的 applies 一致）：
--   crime_type     作案类型：普通 / 流窜作案 / 多次作案 / 结伙作案
--   trial_mode     审理程序：普通程序 / 简易程序 / 速裁程序
--   case_nature    案件性质：公诉 / 自诉
--   custody_status 羁押状态：在押 / 取保 / 监视居住 / 未羁押
--
-- 不加 CHECK 约束：取值枚举可能随实务细化调整，且 SQLite 的 ADD COLUMN 加 CHECK
-- 会校验既有行。空值 '' 由引擎 APPLIES_DEFAULT 兜底，方向安全（取默认＝最保守）。
--
-- migration runner 为每个文件包事务；此文件禁止自带 BEGIN/COMMIT。

ALTER TABLE cases ADD COLUMN crime_type     TEXT NOT NULL DEFAULT '';
ALTER TABLE cases ADD COLUMN trial_mode     TEXT NOT NULL DEFAULT '';
ALTER TABLE cases ADD COLUMN case_nature    TEXT NOT NULL DEFAULT '';
ALTER TABLE cases ADD COLUMN custody_status TEXT NOT NULL DEFAULT '';

-- 索引：按作案类型 + 审理程序筛案件是高频操作（如"列出所有速裁程序案件"）。
CREATE INDEX IF NOT EXISTS idx_cases_crime_type  ON cases(crime_type);
CREATE INDEX IF NOT EXISTS idx_cases_trial_mode  ON cases(trial_mode);
