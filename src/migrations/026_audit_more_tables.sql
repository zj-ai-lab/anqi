-- 026: 联系人、通讯录、案件参与人与财务对象的轻量审计。
-- 沿用 024 上下文；未包装的写入标记 system。对象类型互不混用，id 可精确定位。
-- 不复制姓名/电话/证件/金额/自由文本；仅记对象、案件、动作。UPDATE 忽略纯时间戳空写。
-- 结算 runs/snapshots 原有不可变触发器继续生效；这里只追加审计，不改变业务约束。

CREATE TRIGGER IF NOT EXISTS trg_log_contacts_insert AFTER INSERT ON contacts
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('contact', NEW.id, NEW.case_id, 'insert', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_contacts_update AFTER UPDATE ON contacts
WHEN OLD.case_id IS NOT NEW.case_id OR OLD.role IS NOT NEW.role OR OLD.name IS NOT NEW.name OR OLD.phone IS NOT NEW.phone OR OLD.id_no IS NOT NEW.id_no OR OLD.org IS NOT NEW.org OR OLD.note IS NOT NEW.note OR OLD.created_by IS NOT NEW.created_by
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('contact', NEW.id, NEW.case_id, 'update', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_contacts_delete AFTER DELETE ON contacts
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('contact', OLD.id, OLD.case_id, 'delete', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_people_insert AFTER INSERT ON people
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('person', NEW.id, NULL, 'insert', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_people_update AFTER UPDATE ON people
WHEN OLD.name IS NOT NEW.name OR OLD.phone IS NOT NEW.phone OR OLD.org IS NOT NEW.org OR OLD.note IS NOT NEW.note
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('person', NEW.id, NULL, 'update', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_people_delete AFTER DELETE ON people
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('person', OLD.id, NULL, 'delete', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_case_participants_insert AFTER INSERT ON case_participants
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('case_participant', NEW.id, NEW.case_id, 'insert', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_case_participants_update AFTER UPDATE ON case_participants
WHEN OLD.case_id IS NOT NEW.case_id OR OLD.person_id IS NOT NEW.person_id OR OLD.role IS NOT NEW.role OR OLD.note IS NOT NEW.note
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('case_participant', NEW.id, NEW.case_id, 'update', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_case_participants_delete AFTER DELETE ON case_participants
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('case_participant', OLD.id, OLD.case_id, 'delete', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_fee_items_insert AFTER INSERT ON fee_items
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('fee_item', NEW.id, NEW.case_id, 'insert', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_fee_items_update AFTER UPDATE ON fee_items
WHEN OLD.case_id IS NOT NEW.case_id OR OLD.label IS NOT NEW.label OR OLD.amount IS NOT NEW.amount OR OLD.node IS NOT NEW.node OR OLD.due_on IS NOT NEW.due_on OR OLD.status IS NOT NEW.status OR OLD.paid_on IS NOT NEW.paid_on OR OLD.note IS NOT NEW.note OR OLD.amount_fen IS NOT NEW.amount_fen OR OLD.version IS NOT NEW.version
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('fee_item', NEW.id, NEW.case_id, 'update', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_fee_items_delete AFTER DELETE ON fee_items
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('fee_item', OLD.id, OLD.case_id, 'delete', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_fee_shares_insert AFTER INSERT ON fee_shares
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('fee_share', NEW.id, NEW.case_id, 'insert', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_fee_shares_update AFTER UPDATE ON fee_shares
WHEN OLD.case_id IS NOT NEW.case_id OR OLD.external_case IS NOT NEW.external_case OR OLD.agreement_id IS NOT NEW.agreement_id OR OLD.fee_item_id IS NOT NEW.fee_item_id OR OLD.direction IS NOT NEW.direction OR OLD.counterpart IS NOT NEW.counterpart OR OLD.base_amount IS NOT NEW.base_amount OR OLD.amount IS NOT NEW.amount OR OLD.due_month IS NOT NEW.due_month OR OLD.status IS NOT NEW.status OR OLD.settled_on IS NOT NEW.settled_on OR OLD.note IS NOT NEW.note OR OLD.is_void IS NOT NEW.is_void OR OLD.voided_at IS NOT NEW.voided_at OR OLD.void_reason IS NOT NEW.void_reason OR OLD.amount_fen IS NOT NEW.amount_fen OR OLD.base_amount_fen IS NOT NEW.base_amount_fen OR OLD.assignment_id IS NOT NEW.assignment_id OR OLD.settlement_snapshot_id IS NOT NEW.settlement_snapshot_id OR OLD.entry_kind IS NOT NEW.entry_kind OR OLD.cancelled_at IS NOT NEW.cancelled_at OR OLD.cancel_reason IS NOT NEW.cancel_reason OR OLD.cancelled_by_run_id IS NOT NEW.cancelled_by_run_id OR OLD.person_id IS NOT NEW.person_id
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('fee_share', NEW.id, NEW.case_id, 'update', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_fee_shares_delete AFTER DELETE ON fee_shares
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('fee_share', OLD.id, OLD.case_id, 'delete', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_fee_share_agreements_insert AFTER INSERT ON fee_share_agreements
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('fee_share_agreement', NEW.id, NEW.case_id, 'insert', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_fee_share_agreements_update AFTER UPDATE ON fee_share_agreements
WHEN OLD.case_id IS NOT NEW.case_id OR OLD.direction IS NOT NEW.direction OR OLD.counterpart IS NOT NEW.counterpart OR OLD.contact_id IS NOT NEW.contact_id OR OLD.rate IS NOT NEW.rate OR OLD.flat_amount IS NOT NEW.flat_amount OR OLD.note IS NOT NEW.note OR OLD.status IS NOT NEW.status OR OLD.version IS NOT NEW.version OR OLD.settlement_term IS NOT NEW.settlement_term OR OLD.person_id IS NOT NEW.person_id
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('fee_share_agreement', NEW.id, NEW.case_id, 'update', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_fee_share_agreements_delete AFTER DELETE ON fee_share_agreements
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('fee_share_agreement', OLD.id, OLD.case_id, 'delete', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_fee_share_assignments_insert AFTER INSERT ON fee_share_assignments
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('fee_share_assignment', NEW.id, NEW.case_id, 'insert', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_fee_share_assignments_update AFTER UPDATE ON fee_share_assignments
WHEN OLD.case_id IS NOT NEW.case_id OR OLD.fee_item_id IS NOT NEW.fee_item_id OR OLD.agreement_id IS NOT NEW.agreement_id OR OLD.status IS NOT NEW.status OR OLD.formula_revision_id IS NOT NEW.formula_revision_id OR OLD.revision_choice IS NOT NEW.revision_choice OR OLD.decision_note IS NOT NEW.decision_note OR OLD.decided_by IS NOT NEW.decided_by OR OLD.version IS NOT NEW.version
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('fee_share_assignment', NEW.id, NEW.case_id, 'update', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_fee_share_assignments_delete AFTER DELETE ON fee_share_assignments
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('fee_share_assignment', OLD.id, OLD.case_id, 'delete', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_fee_share_settlement_runs_insert AFTER INSERT ON fee_share_settlement_runs
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('fee_share_settlement_run', NEW.id, NEW.case_id, 'insert', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_fee_share_settlement_runs_update AFTER UPDATE ON fee_share_settlement_runs
WHEN OLD.case_id IS NOT NEW.case_id OR OLD.fee_item_id IS NOT NEW.fee_item_id OR OLD.run_kind IS NOT NEW.run_kind OR OLD.source_run_id IS NOT NEW.source_run_id OR OLD.request_id IS NOT NEW.request_id OR OLD.preview_hash IS NOT NEW.preview_hash OR OLD.preview_inputs_json IS NOT NEW.preview_inputs_json OR OLD.base_amount_fen IS NOT NEW.base_amount_fen OR OLD.fee_version IS NOT NEW.fee_version OR OLD.target_status IS NOT NEW.target_status OR OLD.paid_on IS NOT NEW.paid_on OR OLD.reason IS NOT NEW.reason OR OLD.confirmed_by IS NOT NEW.confirmed_by OR OLD.confirmed_at IS NOT NEW.confirmed_at
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('fee_share_settlement_run', NEW.id, NEW.case_id, 'update', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_fee_share_settlement_runs_delete AFTER DELETE ON fee_share_settlement_runs
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('fee_share_settlement_run', OLD.id, OLD.case_id, 'delete', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_fee_share_settlement_snapshots_insert AFTER INSERT ON fee_share_settlement_snapshots
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('fee_share_settlement_snapshot', NEW.id, NEW.case_id, 'insert', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_fee_share_settlement_snapshots_update AFTER UPDATE ON fee_share_settlement_snapshots
WHEN OLD.settlement_run_id IS NOT NEW.settlement_run_id OR OLD.case_id IS NOT NEW.case_id OR OLD.fee_item_id IS NOT NEW.fee_item_id OR OLD.agreement_id IS NOT NEW.agreement_id OR OLD.formula_revision_id IS NOT NEW.formula_revision_id OR OLD.assignment_id IS NOT NEW.assignment_id OR OLD.plan_version IS NOT NEW.plan_version OR OLD.revision_choice IS NOT NEW.revision_choice OR OLD.source_snapshot_id IS NOT NEW.source_snapshot_id OR OLD.direction IS NOT NEW.direction OR OLD.counterpart IS NOT NEW.counterpart OR OLD.formula_json IS NOT NEW.formula_json OR OLD.trace_json IS NOT NEW.trace_json OR OLD.base_amount_fen IS NOT NEW.base_amount_fen OR OLD.desired_amount_fen IS NOT NEW.desired_amount_fen OR OLD.closed_amount_fen IS NOT NEW.closed_amount_fen OR OLD.new_amount_fen IS NOT NEW.new_amount_fen OR OLD.entry_kind IS NOT NEW.entry_kind OR OLD.due_month IS NOT NEW.due_month
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('fee_share_settlement_snapshot', NEW.id, NEW.case_id, 'update', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;

CREATE TRIGGER IF NOT EXISTS trg_log_fee_share_settlement_snapshots_delete AFTER DELETE ON fee_share_settlement_snapshots
BEGIN
  INSERT INTO change_log(entity, entity_id, case_id, action, origin, actor, rule_id)
  VALUES ('fee_share_settlement_snapshot', OLD.id, OLD.case_id, 'delete', COALESCE((SELECT origin FROM change_context WHERE id=1),'local'), COALESCE((SELECT actor FROM change_context WHERE id=1),'system'), (SELECT rule_id FROM change_context WHERE id=1));
END;
