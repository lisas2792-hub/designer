// repositories/userRepo.js
"use strict";

/**
 * 所有函式都採用「db-first」簽名：
 *   async fn(db, ...args)
 * 其中 db 可以是 pool 或 client（transaction 中）
 * 只要有 .query(sql, params) 介面就可以。
 */

async function getActiveUserById(db, id) {
  const { rows } = await db.query(
    `SELECT id, username, name, is_active
     FROM "user"
     WHERE id = $1 AND is_active = true`,
    [id]
  );
  return rows[0] || null; // projects.js 期待拿到 row 物件（含 name）
}

async function findUserIdByNameOrUsername(db, input) {
  const { rows } = await db.query(
    `SELECT id
       FROM "user"
      WHERE name = $1 OR username = $1
      LIMIT 1`,
    [input]
  );
  return rows[0]?.id ?? null; // projects.js 期待拿到 id (或 null)
}

async function getUserNameById(db, id) {
  const { rows } = await db.query(
    `SELECT name
       FROM "user"
      WHERE id = $1`,
    [id]
  );
  return rows[0] || null; // projects.js 會用 row.name
}

module.exports = {
  getActiveUserById,
  findUserIdByNameOrUsername,
  getUserNameById,
};
