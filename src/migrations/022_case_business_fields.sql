-- 022: cases 新增六个业务字段，经 practitioner review 确认字段语义。

-- ⚠️ 命名坑（务必遵守）：本文的 case_side 是「案件类型＝辩护/控告」，
--    与既有 case_nature（案件性质＝自诉/公诉）不是一回事，必须异名，
--    否则将来联调必然误配（规则里 applies.案件性质 引的是 case_nature）。
--
-- 取值约定（不加 CHECK：枚举可能随实务细化，且 SQLite 的 ADD COLUMN 加 CHECK 会校验既有行）：
--   case_side        案件类型：辩护 / 控告（空＝未指定，控告线立案前规则靠 procedure 匹配，不依赖本列）
--   entrust_stage    委托阶段：单次会见 / 侦查阶段 / 审查起诉 / 一审 / 二审 / 再审 / 全案
--   co_counsel       合作律师：文本（兼容未登记到通讯录的协作方）
--   contract_no      合同编号
--   custody_place    羁押地点：文本，不预设看守所清单
--   handling_agency  办案机关（受理机构）：可为公安局或检察院，语义是"受理机构"
--
-- migration runner 为每个文件包事务；此文件禁止自带 BEGIN/COMMIT。

ALTER TABLE cases ADD COLUMN case_side       TEXT NOT NULL DEFAULT '';
ALTER TABLE cases ADD COLUMN entrust_stage   TEXT NOT NULL DEFAULT '';
ALTER TABLE cases ADD COLUMN co_counsel      TEXT NOT NULL DEFAULT '';
ALTER TABLE cases ADD COLUMN contract_no     TEXT NOT NULL DEFAULT '';
ALTER TABLE cases ADD COLUMN custody_place   TEXT NOT NULL DEFAULT '';
ALTER TABLE cases ADD COLUMN handling_agency TEXT NOT NULL DEFAULT '';

-- 索引：按业务线筛案件（列"全部控告案"、"全部辩护案"）是高频操作。
CREATE INDEX IF NOT EXISTS idx_cases_case_side ON cases(case_side);
