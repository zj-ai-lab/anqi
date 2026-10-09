-- 028: 刑事期限节假日顺延由当事人选择；NULL = 尚未决定（按默认不顺延）。
ALTER TABLE deadlines
  ADD COLUMN criminal_roll_choice TEXT
  CHECK (criminal_roll_choice IN ('default','rolled'));

-- 024 的通用期限触发器在迁移时已经存在，新增列用独立触发器补字段级审计。
CREATE TRIGGER IF NOT EXISTS trg_log_deadlines_criminal_roll_choice_update
AFTER UPDATE OF criminal_roll_choice ON deadlines
WHEN OLD.criminal_roll_choice IS NOT NEW.criminal_roll_choice
BEGIN
  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)
  VALUES ('deadline', NEW.id, NEW.case_id, 'update', 'criminal_roll_choice',
    CAST(OLD.criminal_roll_choice AS TEXT), CAST(NEW.criminal_roll_choice AS TEXT),
    COALESCE((SELECT origin FROM change_context WHERE id=1),'local'),
    COALESCE((SELECT actor FROM change_context WHERE id=1),'system'),
    (SELECT rule_id FROM change_context WHERE id=1));
END;
