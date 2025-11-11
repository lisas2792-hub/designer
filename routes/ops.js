// 手動呼叫 /api/init-admin 來建立第一個管理員，之後所有註冊都會是 member
// (但靠auth.js本身就可以做到自動判斷第一個註冊就是 admin)

//第一次建立的人(系統管理者)
const express = require("express");
const bcrypt = require("bcrypt");
// const { Pool } = require("pg");

// 如果你已有 db.js 的 Pool，改成： const { pool } = require("../db");
const { pool } = require("../db")

const router = express.Router();

/**
 * POST /__ops/init-admin
 * 只允許第一次用來建立「初始系統管理員」。
 * 驗證：
 *   - Header: X-Init-Secret 必須等於 .env 的 INIT_SECRET
 *   - 資料庫內不可已存在任何 admin（is_active=TRUE）使用者
 */
router.post("/init-admin", async (req, res) => {
  try {
    // 1) 驗證初始化密鑰
    const secretFromReq = req.headers["x-init-secret"] || req.query.secret;
    if (!process.env.INIT_SECRET || secretFromReq !== process.env.INIT_SECRET) {
      return res.status(403).json({ ok: false, error: "INIT_SECRET 驗證失敗" });
    }

    const { name, username, password } = req.body || {};
    if (!name || !username || !password) {
      return res.status(400).json({ ok: false, error: "name、username、password 為必填" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 2) 找出 admin 角色 id
      const roleRes = await client.query(
        `SELECT id FROM user_role WHERE code = 'admin' LIMIT 1`
      );
      if (roleRes.rowCount === 0) {
        throw new Error("系統缺少 admin 角色，請先建立 user_role 資料");
      }
      const adminRoleId = roleRes.rows[0].id;

      // 3) 檢查是否已存在任何「有效 admin」
      const adminCountRes = await client.query(
        `SELECT COUNT(*)::int AS cnt
         FROM "user" u
         WHERE u.role_id = $1 AND u.is_active = TRUE`,
        [adminRoleId]
      );
      if (adminCountRes.rows[0].cnt > 0) {
        // 已有 admin，就拒絕（只允許第一次初始化）
        throw new Error("系統已存在系統管理員，初始化已鎖定");
      }

      // 4) 檢查 username 是否已被使用
      const exist = await client.query(
        `SELECT 1 FROM "user" WHERE username = $1 LIMIT 1`,
        [username]
      );
      if (exist.rowCount > 0) {
        throw new Error("該 username 已存在，請改用其他帳號");
      }

      // 5) 產生密碼雜湊
      const rounds = Number(process.env.BCRYPT_ROUNDS || 12);
      const hashed = await bcrypt.hash(password, rounds);

      // 6) 新增第一位 admin
      const insert = await client.query(
        `INSERT INTO "user"(name, username, password, role_id, is_active)
         VALUES ($1,$2,$3,$4, TRUE)
         RETURNING id, name, username, role_id, is_active, created_at`,
        [name, username, hashed, adminRoleId]
      );

      await client.query("COMMIT");
      return res.json({ ok: true, admin: insert.rows[0] });
    } catch (e) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    } finally {
      client.release();
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: "初始化失敗" });
  }
});

module.exports = router;
