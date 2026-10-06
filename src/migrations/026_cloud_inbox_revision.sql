-- Candidate changes wake selected-case sync; no candidate text enters change_log.
CREATE TRIGGER inbox_cloud_insert AFTER INSERT ON inbox BEGIN
 INSERT INTO change_log(entity,entity_id,case_id,action,actor) VALUES('inbox',NEW.id,NEW.case_id,'insert','system');
END;
CREATE TRIGGER inbox_cloud_update AFTER UPDATE ON inbox BEGIN
 INSERT INTO change_log(entity,entity_id,case_id,action,actor) VALUES('inbox',NEW.id,NEW.case_id,'update','system');
END;
CREATE TRIGGER candidate_cloud_insert AFTER INSERT ON legalrag_candidates BEGIN
 INSERT INTO change_log(entity,entity_id,case_id,action,actor) VALUES('candidate',NEW.id,NEW.case_id,'insert','system');
END;
CREATE TRIGGER candidate_cloud_update AFTER UPDATE ON legalrag_candidates BEGIN
 INSERT INTO change_log(entity,entity_id,case_id,action,actor) VALUES('candidate',NEW.id,NEW.case_id,'update','system');
END;
CREATE TRIGGER candidate_fact_cloud_update AFTER UPDATE ON legalrag_candidate_facts BEGIN
 INSERT INTO change_log(entity,entity_id,case_id,action,actor) VALUES('candidate-fact',NEW.id,NEW.case_id,'update','system');
END;
