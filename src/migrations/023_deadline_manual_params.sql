-- 023: deadlines 新增手动参数与 override_reason，用于记录调整理由。
-- 可调整天数/月数数值、单位、起算方式、顺延规则。

-- 三层模型（本案齐只补第一层，第二/三层原已具备）：
--   第一层 · 调参数  → 本迁移新增 manual_*：改一个参数，届满日由引擎自动重算，
--                      期限与法条依据的关联不丢，事后能说清"为什么是这个日期"
--   第二层 · 调锚点  → 改 events.occurred_on，级联重算（recalcPreview / applyRecalc）
--   第三层 · 调结果  → 直接指定 due_on，已由既有 is_manual_override 承担（D4 保护）
--
-- 优先级（engine.js recomputeForDeadline / applyManualParams 实现）：
--   manual_* > 规则默认值 → 算出届满日 → 第三层直接指定的日期优先于计算结果
--
-- 留痕纪律：任一 manual_* 非空即记 is_manual_override=1，并要求写 override_reason。
--           理由字段是执业自证的关键——"特殊情况延长"与"手滑改错"必须能区分。
--
-- 为何 manual_days 可空：NULL 表示"未覆盖，沿用规则天数"；0 是合法覆盖值
--   （如某些期限经协商为 0 日/当日办结），故不能用 0 表示"未设置"。
--
-- migration runner 为每个文件包事务；此文件禁止自带 BEGIN/COMMIT。

ALTER TABLE deadlines ADD COLUMN manual_days       INTEGER;
ALTER TABLE deadlines ADD COLUMN manual_unit       TEXT NOT NULL DEFAULT '';
ALTER TABLE deadlines ADD COLUMN manual_count_from TEXT NOT NULL DEFAULT '';
ALTER TABLE deadlines ADD COLUMN manual_roll       TEXT NOT NULL DEFAULT '';
ALTER TABLE deadlines ADD COLUMN override_reason   TEXT NOT NULL DEFAULT '';
