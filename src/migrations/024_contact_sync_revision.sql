-- Contact changes wake the opted-in sync without copying phone/identity values to change_log.
CREATE TRIGGER contact_sync_insert AFTER INSERT ON contacts BEGIN
 INSERT INTO change_log(entity,entity_id,case_id,action,actor) VALUES('contact',NEW.id,NEW.case_id,'insert','system');
END;
CREATE TRIGGER contact_sync_update AFTER UPDATE ON contacts
WHEN OLD.role IS NOT NEW.role OR OLD.name IS NOT NEW.name OR OLD.phone IS NOT NEW.phone OR OLD.id_no IS NOT NEW.id_no OR OLD.org IS NOT NEW.org OR OLD.note IS NOT NEW.note BEGIN
 INSERT INTO change_log(entity,entity_id,case_id,action,actor) VALUES('contact',NEW.id,NEW.case_id,'update','system');
END;
CREATE TRIGGER contact_sync_delete AFTER DELETE ON contacts BEGIN
 INSERT INTO change_log(entity,entity_id,case_id,action,actor) VALUES('contact',OLD.id,OLD.case_id,'delete','system');
END;
