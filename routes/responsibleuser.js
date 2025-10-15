// 前端「負責人」下拉選單用
const express = require("express");
const { pool } = require("../db");
const { attachUser, requireAuth } = require("../middleware/auth");

const router = express.Router();

// 啟動時印一行，確認有載到這支路由
console.log("[routes] responsibleuser loaded");

/* 健康檢查：GET /api/responsible-user/ping */
router.get("/ping", (_req, res) => {
  console.log("[responsible-user] /ping hit");
  res.json({ ok: true });
});

// 🟡 偵錯用：確認 attachUser 是否還原出 req.user
router.get("/whoami", attachUser, (req, res) => {
  res.json({ ok: true, user: req.user ?? null });
});

/**
 * 下拉選單（重點）：
 * - 前端呼叫：GET /api/responsible-user/options
 * - 套用登入驗證：
 *   - attachUser：從 JWT Cookie 還原 req.user
 *   - requireAuth：未登入回 401
 * - 權限邏輯：
 *   - admin：回所有使用者（可選擇加 is_active 過濾）
 *   - member：只回「自己」一筆，避免看見別人
 * - 回傳格式：
 *   { ok: true, data: [{ id, username, display_name }] }
 *   其中 display_name 會優先使用 display_name 欄，否則 fallback 到 username
 */
router.get(
  "/options",
  attachUser,   // 解析 JWT -> req.user = { id, username, role }
  requireAuth,  // 未登入就擋下
  async (_req, res) => {
    try {
      const rs = await pool.query(
        `
        SELECT
          id,
          username,
          name,
          role_id,
          COALESCE(NULLIF(TRIM(name), ''), username) AS display_name
        FROM "user"
        WHERE COALESCE(is_active, TRUE) = TRUE --過濾啟用帳號
        -- 排序規則：
        -- 1) role_id 由小到大（系統管理員在前)
        -- 2) id 由小到大
        ORDER BY role_id ASC, id ASC
        `
      );

      return res.json({
        ok: true,
        data: rs.rows.map(u => ({
          id: String(u.id),
          username: u.username,
          name: u.name,
        })),
      });
    } catch (e) {
      console.error("[GET /responsible-user/options] error:", e);
      res.status(500).json({ ok: false, message: "load users failed" });
    }
  }
);

module.exports = router;
