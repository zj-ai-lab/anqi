-- 025: cases 分类字段。回填依赖 024 已存在的 change_log/change_context。
ALTER TABLE cases ADD COLUMN case_type TEXT NOT NULL DEFAULT '未分类' CHECK(case_type IN ('民事','刑事','行政','非诉','其他','未分类'));
CREATE INDEX IF NOT EXISTS idx_cases_case_type ON cases(case_type);
CREATE TRIGGER IF NOT EXISTS trg_log_cases_case_type_update AFTER UPDATE OF case_type ON cases
WHEN OLD.case_type IS NOT NEW.case_type
BEGIN
  INSERT INTO change_log(entity,entity_id,case_id,action,field,old_value,new_value,origin,actor,rule_id)
  VALUES('case',NEW.id,NEW.id,'update','case_type',OLD.case_type,NEW.case_type,COALESCE((SELECT origin FROM change_context WHERE id=1),'local'),COALESCE((SELECT actor FROM change_context WHERE id=1),'system'),(SELECT rule_id FROM change_context WHERE id=1));
END;
UPDATE cases SET case_type='刑事' WHERE procedure LIKE '刑事%';
UPDATE cases SET case_type='民事' WHERE procedure IN ('一审','二审') AND case_type='未分类';
