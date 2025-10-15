-- 回滾：移除 trigger 與 function
BEGIN;
SET search_path = public;

DROP TRIGGER IF EXISTS trg_project_responsible_sync ON project;
DROP FUNCTION IF EXISTS fn_sync_project_responsible_name();

COMMIT;
