"use strict";
const { pool } = require("../db");

/**
 * 新增 / 更新 project_text_upload
 * ★ 已新增 uploaded_by_name 欄位
 *
 * payload = {
 *   project_id,
 *   text_no,
 *   file_url,
 *   drive_file_id,
 *   thumbnail_link,
 *   uploaded_by_name   ← 這個是 stageupload.js 傳進來的
 * }
 */
async function upsertProjectTextUpload(client, {
  project_id,
  text_no,
  file_url,
  drive_file_id,
  thumbnail_link,
  uploaded_by_name
}) {

  const sql = `
    INSERT INTO project_text_upload
      (project_id, text_no, file_url, drive_file_id, thumbnail_link, uploaded_by_name, completed_at, updated_at)
    VALUES
      ($1,         $2,      $3,       $4,           $5,             $6,               NOW(),       NOW())
    ON CONFLICT (project_id, text_no)
    DO UPDATE SET
      file_url          = EXCLUDED.file_url,
      drive_file_id     = EXCLUDED.drive_file_id,
      thumbnail_link    = EXCLUDED.thumbnail_link,
      uploaded_by_name  = EXCLUDED.uploaded_by_name,
      completed_at      = NOW(),
      updated_at        = NOW()
    RETURNING *;
  `;

  const params = [
    project_id,
    text_no,
    file_url,
    drive_file_id,
    thumbnail_link,
    uploaded_by_name
  ];

  const { rows } = await client.query(sql, params);
  return rows[0];
}


/**
 * 取得最後一次上傳（保持你原本的行為）
 */
async function getLastUpload(client, { project_id, text_no }) {
  const sql = `
    SELECT file_url, thumbnail_link, drive_file_id, uploaded_by_name,
           COALESCE(updated_at, completed_at) AS ts
    FROM project_text_upload
    WHERE text_no = $2
      AND (
        project_id = $1
        OR project_id = (SELECT id::text FROM project WHERE project_id = $1 LIMIT 1)
      )
    ORDER BY COALESCE(updated_at, completed_at) DESC NULLS LAST
    LIMIT 1;
  `;

  const { rows } = await client.query(sql, [project_id, text_no]);
  return rows[0] || null;
}

module.exports = { upsertProjectTextUpload, getLastUpload };
