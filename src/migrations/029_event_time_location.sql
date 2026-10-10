-- 029: 开庭时刻/地点与期限顺延前原日期。
ALTER TABLE events ADD COLUMN occurred_time TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN location TEXT NOT NULL DEFAULT '';
ALTER TABLE deadlines ADD COLUMN rolled_from TEXT NOT NULL DEFAULT '';

-- 历史算法说明中的原届满日回填；没有明确「届满日」或非顺延记录保持空。
UPDATE deadlines
SET rolled_from = substr(ltrim(substr(calc_note, instr(calc_note, '届满日') + 3)), 1, 10)
WHERE rolled_from = ''
  AND (calc_note LIKE '%顺延至%' OR calc_note LIKE '%前移至%')
  AND substr(ltrim(substr(calc_note, instr(calc_note, '届满日') + 3)), 1, 10)
      GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]';

-- 024 的通用 UPDATE 触发器必须显式纳入新列；不能用独立补丁触发器，
-- 否则 test-migration-024 的逐列闸门会看不到列。
DROP TRIGGER IF EXISTS trg_log_events_update;
CREATE TRIGGER trg_log_events_update AFTER UPDATE ON events
BEGIN
  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)
  SELECT 'event', NEW.id, NEW.case_id, 'update', d.field, d.old_value, d.new_value,
    COALESCE((SELECT origin FROM change_context WHERE id=1),'local'),
    COALESCE((SELECT actor FROM change_context WHERE id=1),'system'),
    (SELECT rule_id FROM change_context WHERE id=1)
  FROM (
    SELECT 'case_id' AS field, CAST(OLD.case_id AS TEXT) AS old_value, CAST(NEW.case_id AS TEXT) AS new_value WHERE OLD.case_id IS NOT NEW.case_id
    UNION ALL SELECT 'type' AS field, CAST(OLD.type AS TEXT), CAST(NEW.type AS TEXT) WHERE OLD.type IS NOT NEW.type
    UNION ALL SELECT 'occurred_on' AS field, CAST(OLD.occurred_on AS TEXT), CAST(NEW.occurred_on AS TEXT) WHERE OLD.occurred_on IS NOT NEW.occurred_on
    UNION ALL SELECT 'service_method' AS field, CAST(OLD.service_method AS TEXT), CAST(NEW.service_method AS TEXT) WHERE OLD.service_method IS NOT NEW.service_method
    UNION ALL SELECT 'instrument' AS field, CAST(OLD.instrument AS TEXT), CAST(NEW.instrument AS TEXT) WHERE OLD.instrument IS NOT NEW.instrument
    UNION ALL SELECT 'note' AS field, CAST(OLD.note AS TEXT), CAST(NEW.note AS TEXT) WHERE OLD.note IS NOT NEW.note
    UNION ALL SELECT 'created_by' AS field, CAST(OLD.created_by AS TEXT), CAST(NEW.created_by AS TEXT) WHERE OLD.created_by IS NOT NEW.created_by
    UNION ALL SELECT 'created_at' AS field, CAST(OLD.created_at AS TEXT), CAST(NEW.created_at AS TEXT) WHERE OLD.created_at IS NOT NEW.created_at
    UNION ALL SELECT 'occurred_time' AS field, CAST(OLD.occurred_time AS TEXT), CAST(NEW.occurred_time AS TEXT) WHERE OLD.occurred_time IS NOT NEW.occurred_time
    UNION ALL SELECT 'location' AS field, CAST(OLD.location AS TEXT), CAST(NEW.location AS TEXT) WHERE OLD.location IS NOT NEW.location
  ) d;
END;

DROP TRIGGER IF EXISTS trg_log_deadlines_update;
CREATE TRIGGER trg_log_deadlines_update AFTER UPDATE ON deadlines
BEGIN
  INSERT INTO change_log (entity, entity_id, case_id, action, field, old_value, new_value, origin, actor, rule_id)
  SELECT 'deadline', NEW.id, NEW.case_id, 'update', d.field, d.old_value, d.new_value,
    COALESCE((SELECT origin FROM change_context WHERE id=1),'local'),
    COALESCE((SELECT actor FROM change_context WHERE id=1),'system'),
    (SELECT rule_id FROM change_context WHERE id=1)
  FROM (
    SELECT 'case_id' AS field, CAST(OLD.case_id AS TEXT) AS old_value, CAST(NEW.case_id AS TEXT) AS new_value WHERE OLD.case_id IS NOT NEW.case_id
    UNION ALL SELECT 'name' AS field, CAST(OLD.name AS TEXT), CAST(NEW.name AS TEXT) WHERE OLD.name IS NOT NEW.name
    UNION ALL SELECT 'due_on' AS field, CAST(OLD.due_on AS TEXT), CAST(NEW.due_on AS TEXT) WHERE OLD.due_on IS NOT NEW.due_on
    UNION ALL SELECT 'trigger_event_id' AS field, CAST(OLD.trigger_event_id AS TEXT), CAST(NEW.trigger_event_id AS TEXT) WHERE OLD.trigger_event_id IS NOT NEW.trigger_event_id
    UNION ALL SELECT 'rule_id' AS field, CAST(OLD.rule_id AS TEXT), CAST(NEW.rule_id AS TEXT) WHERE OLD.rule_id IS NOT NEW.rule_id
    UNION ALL SELECT 'basis' AS field, CAST(OLD.basis AS TEXT), CAST(NEW.basis AS TEXT) WHERE OLD.basis IS NOT NEW.basis
    UNION ALL SELECT 'calc_note' AS field, CAST(OLD.calc_note AS TEXT), CAST(NEW.calc_note AS TEXT) WHERE OLD.calc_note IS NOT NEW.calc_note
    UNION ALL SELECT 'is_manual_override' AS field, CAST(OLD.is_manual_override AS TEXT), CAST(NEW.is_manual_override AS TEXT) WHERE OLD.is_manual_override IS NOT NEW.is_manual_override
    UNION ALL SELECT 'severity' AS field, CAST(OLD.severity AS TEXT), CAST(NEW.severity AS TEXT) WHERE OLD.severity IS NOT NEW.severity
    UNION ALL SELECT 'status' AS field, CAST(OLD.status AS TEXT), CAST(NEW.status AS TEXT) WHERE OLD.status IS NOT NEW.status
    UNION ALL SELECT 'done_at' AS field, CAST(OLD.done_at AS TEXT), CAST(NEW.done_at AS TEXT) WHERE OLD.done_at IS NOT NEW.done_at
    UNION ALL SELECT 'created_at' AS field, CAST(OLD.created_at AS TEXT), CAST(NEW.created_at AS TEXT) WHERE OLD.created_at IS NOT NEW.created_at
    UNION ALL SELECT 'review_status' AS field, CAST(OLD.review_status AS TEXT), CAST(NEW.review_status AS TEXT) WHERE OLD.review_status IS NOT NEW.review_status
    UNION ALL SELECT 'created_by' AS field, CAST(OLD.created_by AS TEXT), CAST(NEW.created_by AS TEXT) WHERE OLD.created_by IS NOT NEW.created_by
    UNION ALL SELECT 'manual_days' AS field, CAST(OLD.manual_days AS TEXT), CAST(NEW.manual_days AS TEXT) WHERE OLD.manual_days IS NOT NEW.manual_days
    UNION ALL SELECT 'manual_unit' AS field, CAST(OLD.manual_unit AS TEXT), CAST(NEW.manual_unit AS TEXT) WHERE OLD.manual_unit IS NOT NEW.manual_unit
    UNION ALL SELECT 'manual_count_from' AS field, CAST(OLD.manual_count_from AS TEXT), CAST(NEW.manual_count_from AS TEXT) WHERE OLD.manual_count_from IS NOT NEW.manual_count_from
    UNION ALL SELECT 'manual_roll' AS field, CAST(OLD.manual_roll AS TEXT), CAST(NEW.manual_roll AS TEXT) WHERE OLD.manual_roll IS NOT NEW.manual_roll
    UNION ALL SELECT 'override_reason' AS field, CAST(OLD.override_reason AS TEXT), CAST(NEW.override_reason AS TEXT) WHERE OLD.override_reason IS NOT NEW.override_reason
    UNION ALL SELECT 'advisory' AS field, CAST(OLD.advisory AS TEXT), CAST(NEW.advisory AS TEXT) WHERE OLD.advisory IS NOT NEW.advisory
    UNION ALL SELECT 'suppressed_reason' AS field, CAST(OLD.suppressed_reason AS TEXT), CAST(NEW.suppressed_reason AS TEXT) WHERE OLD.suppressed_reason IS NOT NEW.suppressed_reason
    UNION ALL SELECT 'criminal_roll_choice' AS field, CAST(OLD.criminal_roll_choice AS TEXT), CAST(NEW.criminal_roll_choice AS TEXT) WHERE OLD.criminal_roll_choice IS NOT NEW.criminal_roll_choice
    UNION ALL SELECT 'rolled_from' AS field, CAST(OLD.rolled_from AS TEXT), CAST(NEW.rolled_from AS TEXT) WHERE OLD.rolled_from IS NOT NEW.rolled_from
  ) d;
END;
