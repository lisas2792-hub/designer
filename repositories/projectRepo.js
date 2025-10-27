// repositories/projectRepo.js
"use strict";

const { pool } = require("../db");

/** 新增專案 */
async function insertProject(client, data) {
  const {
    project_id,
    name,
    stage_id,
    start_date,
    estimated_days,
    due_date,
    responsible_user_id,
    responsible_user_name,
    creator_user_id,
    creator_user_name,
  } = data;

  const sql = `
    INSERT INTO project (
      project_id, name, stage_id, start_date, estimated_days, due_date,
      responsible_user_id, responsible_user_name,
      creator_user_id, creator_user_name, created_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
    RETURNING *;
  `;

  const { rows } = await client.query(sql, [
    project_id,
    name,
    stage_id,
    start_date,
    estimated_days,
    due_date,
    responsible_user_id,
    responsible_user_name,
    creator_user_id,
    creator_user_name,
  ]);
  return rows[0];
}

/** 
 * ★ UPDATED：專案列表（支援權限過濾）
 * - 呼叫方式：listProjects(pool, { viewerId, isAdmin, limit: 200 })
 * - 管理員：看全部
 * - 一般會員：只看「自己建立」或「被指派」的專案
 * - 若第二參數未提供（舊呼叫法），預設視為管理員看前 200 筆（相容舊版）
 */
async function listProjects(dbOrClient = pool, opts) {
  // ★ UPDATED START
  // 參數相容：若 opts 是物件就取用；否則給預設
  const isOptsObj = opts && typeof opts === "object";
  const viewerId = isOptsObj && Number.isFinite(Number(opts.viewerId)) ? Number(opts.viewerId) : null;
  const isAdmin  = isOptsObj && typeof opts.isAdmin === "boolean" ? opts.isAdmin : true; // 預設 admin 以相容舊版
  const limit    = isOptsObj && Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : 200;

  // 可選：依需求把 JOIN 打開以取得即時名稱（你資料表已有 *_user_name 欄位，JOIN 純增補）
  const baseSelect = `
    SELECT
      p.*,
      cu.name AS creator_name_join,
      ru.name AS responsible_name_join
    FROM project p
    LEFT JOIN "user" cu ON cu.id = p.creator_user_id
    LEFT JOIN "user" ru ON ru.id = p.responsible_user_id
  `;

  let sql, params;

  if (isAdmin) {
    sql = `
      ${baseSelect}
      ORDER BY p.created_at DESC
      LIMIT $1
    `;
    params = [limit];
  } else {
    sql = `
      ${baseSelect}
      WHERE p.creator_user_id = $1
         OR p.responsible_user_id = $1
      ORDER BY p.created_at DESC
      LIMIT $2
    `;
    params = [viewerId, limit];
  }

  const { rows } = await dbOrClient.query(sql, params);
  return rows;
  // ★ UPDATED END
}

/** 以 id 查單筆 */
async function getProjectById(clientOrPool, id) {
  const { rows } = await clientOrPool.query(
    `SELECT * FROM project WHERE id = $1;`,
    [id]
  );
  return rows[0] || null;
}

/** 取得要更新前的舊資料（for PATCH） */
async function getProjectForPatch(client, id) {
  const { rows } = await client.query(`SELECT * FROM project WHERE id = $1;`, [id]);
  return rows[0] || null;
}

/** 動態更新專案（僅更新有傳入欄位的） */
async function updateProjectDynamic(client, id, patch) {
  const keys = Object.keys(patch).filter(k => patch[k] !== undefined);
  if (keys.length === 0) return null;

  const setSql = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const values = keys.map(k => patch[k]);
  values.push(id);

  const sql = `UPDATE project SET ${setSql}, updated_at = NOW() WHERE id = $${values.length} RETURNING *;`;
  const { rows } = await client.query(sql, values);
  return rows[0] || null;
}

/** 刪除專案 */
async function deleteProjectById(clientOrPool, id) {
  await clientOrPool.query(`DELETE FROM project WHERE id = $1;`, [id]);
  return true;
}

/** 設為完成（不碰負責人） */
async function completeProject(projectId) {
  await pool.query(
    `UPDATE project SET is_completed = TRUE, completed_at = NOW() WHERE id = $1;`,
    [Number(projectId)]
  );
}

/** 更新負責人（允許 NULL） */
async function updateResponsible(projectId, responsibleUserId) {
  const _pid = Number(projectId);
  const _rid =
    responsibleUserId === "" || responsibleUserId === undefined || responsibleUserId === null
      ? null
      : Number(responsibleUserId);

  await pool.query(
    `
    UPDATE project
    SET
      responsible_user_id   = $1,
      responsible_user_name = (SELECT u.name FROM "user" u WHERE u.id = $1),
      updated_at            = NOW()
    WHERE id = $2
    `,
    [_rid, _pid]
  );
}

module.exports = {
  insertProject,
  listProjects,       // ★ UPDATED：已改為支援權限過濾
  getProjectById,
  getProjectForPatch,
  updateProjectDynamic,
  deleteProjectById,
  completeProject,
  updateResponsible,
};
