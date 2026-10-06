ALTER TABLE cases ADD COLUMN case_type TEXT NOT NULL DEFAULT '未分类' CHECK(case_type IN ('民事','刑事','行政','非诉','其他','未分类'));
CREATE TRIGGER case_type_revision AFTER UPDATE OF case_type ON cases WHEN OLD.case_type IS NOT NEW.case_type BEGIN
 INSERT INTO change_log(entity,entity_id,case_id,action,field,old_value,new_value,origin,actor)
 VALUES('case',NEW.id,NEW.id,'update','case_type',OLD.case_type,NEW.case_type,COALESCE((SELECT origin FROM change_context WHERE id=1),'local'),COALESCE((SELECT actor FROM change_context WHERE id=1),'system'));
END;
UPDATE cases SET case_type='刑事' WHERE procedure LIKE '刑事%';
UPDATE cases SET case_type='民事' WHERE procedure IN ('一审','二审');
