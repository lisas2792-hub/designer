-- 將 project.responsible_user_name 由 responsible_user_id 自動同步（INSERT/UPDATE）
BEGIN;
SET search_path = public;

-- 1) 建立/覆寫：同步名字的函式
CREATE OR REPLACE FUNCTION fn_sync_project_responsible_name()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.responsible_user_id IS NULL THEN
    NEW.responsible_user_name := NULL;
  ELSE
    SELECT u.name
      INTO NEW.responsible_user_name
      FROM "user" AS u
     WHERE u.id = NEW.responsible_user_id;
  END IF;
  RETURN NEW;
END;
$$;

-- 2) 先移除舊的同名 trigger（可重入）
DROP TRIGGER IF EXISTS trg_project_responsible_sync ON project;

-- 3) 建立 trigger：在插入或變更負責人時自動同步名字
CREATE TRIGGER trg_project_responsible_sync
BEFORE INSERT OR UPDATE OF responsible_user_id ON project
FOR EACH ROW
EXECUTE FUNCTION fn_sync_project_responsible_name();

COMMIT;
