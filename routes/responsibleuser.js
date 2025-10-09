// 前端「負責人」下拉選單用
const express = require("express");
const { pool } = require("../db");
const auth = require("./auth"); // 直接引用你剛完成的 routes/auth.js（裡面掛了 attachUser/requireAuth）

const router = express.Router();

// 啟動時印一行，確認有載到這支路由
console.log("[routes] responsibleuser loaded");

/* 健康檢查：GET /api/responsible-user/ping */
router.get("/ping", (_req, res) => {
  console.log("[responsible-user] /ping hit");
  res.json({ ok: true });
});

// 🟡 偵錯用：確認 attachUser 是否還原出 req.user
router.get("/whoami", auth.attachUser, (req, res) => {
  res.json({ ok: true, user: req.user ?? null });
});

/**
 * 下拉選單（重點）：
 * - 前端呼叫：GET /api/responsible-user/options
 * - 套用登入驗證：
 *   - auth.attachUser：從 JWT Cookie 還原 req.user
 *   - auth.requireAuth：未登入回 401
 * - 權限邏輯：
 *   - admin：回所有使用者（可選擇加 is_active 過濾）
 *   - member：只回「自己」一筆，避免看見別人
 * - 回傳格式：
 *   { ok: true, data: [{ id, username, display_name }] }
 *   其中 display_name 會優先使用 display_name 欄，否則 fallback 到 username
 */
router.get(
  "/options",
  auth.attachUser,   // 解析 JWT -> req.user = { id, username, role }
  auth.requireAuth,  // 未登入就擋下
  async (req, res) => {
    try {
      // 依角色回不同內容
      if (req.user.role === "admin") {
        // 管理者：看到全部人
        const rs = await pool.query(
          `
          SELECT
            id,
            username,
            -- 🟡 更安全：若沒有 display_name 欄位之外的 name，就不要引用 name，避免 500
            COALESCE(name, username) AS display_name
          FROM "user"
          -- 如需只回啟用帳號，可打開下一行
          -- WHERE is_active = TRUE
          ORDER BY id
          `
        );

        return res.json({
          ok: true,
          data: rs.rows.map(u => ({
            id: u.id,
            username: u.username,
            display_name: u.display_name,
          })),
        });
      } else {
        // 一般成員：只回自己
        const rs = await pool.query(
          `
          SELECT
            id,
            username,
            COALESCE(name, username) AS display_name
          FROM "user"
          WHERE id = $1
          -- AND is_active = TRUE
          LIMIT 1
          `,
          [req.user.id]
        );

        return res.json({
          ok: true,
          data: rs.rows.map(u => ({
            id: u.id,
            username: u.username,
            display_name: u.display_name,
          })),
        });
      }
    } catch (e) {
      console.error("[GET /responsible-user/options] error:", e);
      res.status(500).json({ ok: false, message: "load users failed" });
    }
  }
);

module.exports = router;
