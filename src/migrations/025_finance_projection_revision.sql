CREATE TRIGGER finance_projection_fee_items_insert AFTER INSERT ON fee_items BEGIN
 INSERT INTO change_log(entity,entity_id,case_id,action,actor) VALUES('finance',NEW.id,NEW.case_id,'insert','system');
END;
CREATE TRIGGER finance_projection_fee_items_update AFTER UPDATE ON fee_items BEGIN
 INSERT INTO change_log(entity,entity_id,case_id,action,actor) VALUES('finance',NEW.id,NEW.case_id,'update','system');
END;
CREATE TRIGGER finance_projection_fee_items_delete AFTER DELETE ON fee_items BEGIN
 INSERT INTO change_log(entity,entity_id,case_id,action,actor) VALUES('finance',OLD.id,OLD.case_id,'delete','system');
END;
CREATE TRIGGER finance_projection_fee_shares_insert AFTER INSERT ON fee_shares BEGIN
 INSERT INTO change_log(entity,entity_id,case_id,action,actor) VALUES('finance',NEW.id,NEW.case_id,'insert','system');
END;
CREATE TRIGGER finance_projection_fee_shares_update AFTER UPDATE ON fee_shares BEGIN
 INSERT INTO change_log(entity,entity_id,case_id,action,actor) VALUES('finance',NEW.id,NEW.case_id,'update','system');
END;
CREATE TRIGGER finance_projection_fee_shares_delete AFTER DELETE ON fee_shares BEGIN
 INSERT INTO change_log(entity,entity_id,case_id,action,actor) VALUES('finance',OLD.id,OLD.case_id,'delete','system');
END;
CREATE TRIGGER finance_projection_fee_share_agreements_insert AFTER INSERT ON fee_share_agreements BEGIN
 INSERT INTO change_log(entity,entity_id,case_id,action,actor) VALUES('finance',NEW.id,NEW.case_id,'insert','system');
END;
CREATE TRIGGER finance_projection_fee_share_agreements_update AFTER UPDATE ON fee_share_agreements BEGIN
 INSERT INTO change_log(entity,entity_id,case_id,action,actor) VALUES('finance',NEW.id,NEW.case_id,'update','system');
END;
CREATE TRIGGER finance_projection_fee_share_agreements_delete AFTER DELETE ON fee_share_agreements BEGIN
 INSERT INTO change_log(entity,entity_id,case_id,action,actor) VALUES('finance',OLD.id,OLD.case_id,'delete','system');
END;
