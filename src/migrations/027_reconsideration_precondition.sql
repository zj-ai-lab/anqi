-- 027: 行政案件复议前置标记 + 参考期限标记 + 直接起诉期限抑制原因。
-- 复议前置标记由案件编辑 API 校验，数据库 CHECK 再兜底；默认未知，避免历史案件静默作出法律判断。
ALTER TABLE cases
  ADD COLUMN reconsideration_precondition TEXT NOT NULL DEFAULT 'unknown'
  CHECK (reconsideration_precondition IN ('yes','no','unknown'));

ALTER TABLE deadlines
  ADD COLUMN advisory INTEGER NOT NULL DEFAULT 0 CHECK (advisory IN (0,1));

ALTER TABLE deadlines
  ADD COLUMN suppressed_reason TEXT;

CREATE TRIGGER IF NOT EXISTS trg_log_cases_reconsideration_precondition_update
AFTER UPDATE OF reconsideration_precondition ON cases
WHEN OLD.reconsideration_precondition IS NOT NEW.reconsideration_precondition
BEGIN
  INSERT INTO change_log(entity,entity_id,case_id,action,field,old_value,new_value,origin,actor,rule_id)
  VALUES('case',NEW.id,NEW.id,'update','reconsideration_precondition',OLD.reconsideration_precondition,NEW.reconsideration_precondition,
    COALESCE((SELECT origin FROM change_context WHERE id=1),'local'),
    COALESCE((SELECT actor FROM change_context WHERE id=1),'system'),
    (SELECT rule_id FROM change_context WHERE id=1));
END;
