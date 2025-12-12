// routes/reminders.js
"use strict";
const express = require("express");
const router = express.Router();

/**
 * 穩定版路由：
 * - 自動偵測 DB 模組；找不到也不 500
 * - Admin => 顯示所有使用者；非 Admin => 只顯示自己
 * - 有沒有 reminder 表都 OK（沒有就統計 0）
 * - 永遠回 200 { ok: true, data: [...] }
 *
 * ✅ 你要求的變更與補強：
 *   - /persons 的顯示名稱以 name → username 的 fallback（避免 display_name 欄位不存在）
 *   - / 的 GET：回傳 open 列表（含 created_at、due_days）；next_due 改以 created_at + due_days 算
 *   - / 的 POST：寫入 reminder，且同時保存 assignee_id + assignee_username、creator_id + creator_username
 *   - 期限天數 due_days 必須 >= 1（沒有 0）
 */

// -----------------------------
// DB 模組自動解析（多路徑）
// -----------------------------
let db = null;
(function resolveDb() {
  const candidates = [
    "../db",
    "../lib/db",
    "../services/db",
    "../utils/db",
    "../repositories/db",
  ];
  for (const p of candidates) {
    try {
      const mod = require(p);
      if (mod?.query) { db = mod; break; }
      if (mod?.pool?.query) { db = { query: mod.pool.query.bind(mod.pool) }; break; }
      if (mod?.default?.query) { db = mod.default; break; }
    } catch (_) {}
  }
  console.log(`[reminders] DB module ${db ? "resolved" : "NOT FOUND (stub mode)"}`);
})();

/* =========================================
 * GET /persons
 * - Admin：全部
 * - 一般：只有自己
 * - display_name = COALESCE(NULLIF(TRIM(name), ''), username)
 * - open_count 來自 reminder.status='open'
 * - next_due 以 created_at + due_days 計算最早到期（若表不存在則忽略）
 * ========================================= */
router.get("/persons", async (req, res) => {
  const me = req.user || null;
  const isAdmin = !!me && (me.role === "admin" || me.is_admin === true);

  try {
    // 1) 使用者清單
    let users = [];
    if (db) {
      if (isAdmin) {
        const r = await db.query(`
          SELECT
            id,
            username,
            COALESCE(NULLIF(TRIM(name), ''), username) AS display_name
          FROM "user"
          ORDER BY id ASC
        `);
        users = r.rows || [];
      } else if (me?.id) {
        const r = await db.query(`
          SELECT
            id,
            username,
            COALESCE(NULLIF(TRIM(name), ''), username) AS display_name
          FROM "user"
          WHERE id = $1
          LIMIT 1
        `, [me.id]);
        users = r.rows || [];
      }
    } else {
      // 沒 DB：安全回傳
      if (!isAdmin && me?.id) {
        users = [{
          id: me.id,
          username: me.username,
          display_name: me.name || me.username,
        }];
      } else {
        users = [];
      }
    }

    // 2) 統計 open_count + next_due（若沒有 reminder 表，這段 try 會被忽略）
    const statMap = new Map();
    if (db) {
      try {
        // 用 created_at + due_days 算出到期日，抓最早的那一個
        const s = await db.query(`
          SELECT
            r.assignee_id,
            COUNT(*) FILTER (WHERE r.status = 'open') AS open_count,
            MIN(r.created_at + (r.due_days || ' days')::interval) FILTER
              (WHERE r.status = 'open' AND r.due_days IS NOT NULL AND r.due_days > 0) AS next_due
          FROM reminder r
          GROUP BY r.assignee_id
        `);

        for (const row of s.rows || []) {
          statMap.set(Number(row.assignee_id), {
            open_count: Number(row.open_count || 0),
            next_due: row.next_due || null,
          });
        }
      } catch (_) {
        // 沒有 reminder 表或欄位不齊 → 忽略，保持 0
      }
    }

    // 3) 組輸出
    const data = (users || []).map(u => ({
      id: Number(u.id),
      username: u.username,
      display_name: u.display_name,
      stats: statMap.get(Number(u.id)) || { open_count: 0, next_due: null },
    }));

    return res.json({ ok: true, data });
  } catch (err) {
    console.error("[reminders] persons error:", err);
    return res.json({ ok: true, data: [] });
  }
});

/* =========================================
 * GET /
 * 取得提醒清單
 * - ?status=open | done | all（預設 open）
 * - 回傳欄位：id, title, content, assignee_id, assignee_username,
 *             creator_id, creator_username, due_days, status, created_at
 * - 依 created_at ASC（前端會把新增的放在最後）
 * ========================================= */
router.get("/", async (req, res) => {
  const status = String(req.query.status || "open").toLowerCase();
  try {
    if (!db) return res.json({ ok: true, data: [] });

    const arg = (status === "all") ? "all" : status;
    const sql = `
      SELECT
        id, title, content,
        assignee_id, assignee_username,
        creator_id,  creator_username,
        due_days, status, created_at
      FROM reminder
      WHERE ($1 = 'all') OR (status = $1)
      ORDER BY created_at ASC, id ASC
    `;
    const r = await db.query(sql, [arg]);
    return res.json({ ok: true, data: r.rows || [] });
  } catch (err) {
    console.error("[reminders] list error:", err);
    return res.status(200).json({ ok: true, data: [] });
  }
});

/* =========================================
 * POST /
 * 新增提醒
 * body:
 *   - title: string|null（案名，可空）
 *   - content: string|null（內容，可空）
 *   - assignee_id: number（必填）
 *   - due_days: number（必填，>=1）
 *   - status: 'open'|'done'（預設 open）
 *
 * 同時保存：
 *   - assignee_username（由 assignee_id 反查 user.username）
 *   - creator_id / creator_username（取自 req.user）
 * ========================================= */
router.post("/", async (req, res) => {
  try {
    if (!db) return res.status(500).json({ ok: false, error: "DB_NOT_AVAILABLE" });

    let { title = null, content = null, assignee_id, due_days, status = "open" } = req.body || {};
    const assigneeId = Number(assignee_id);
    const dueDays = Number(due_days);

    if (!Number.isInteger(assigneeId) || assigneeId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_ASSIGNEE" });
    }
    if (!Number.isInteger(dueDays) || dueDays <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_DUE_DAYS" });
    }
    status = String(status || "open");

    // 反查被指派者 username（若查不到，仍允許，只是存 null）
    let assigneeUsername = null;
    try {
      const q = await db.query(`SELECT username FROM "user" WHERE id = $1`, [assigneeId]);
      assigneeUsername = q.rows?.[0]?.username || null;
    } catch (_) {}

    // 建立者
    const creatorId = req.user?.id ?? null;
    const creatorUsername = req.user?.username ?? null;

    // 寫入
    const r = await db.query(
      `
      INSERT INTO reminder (
        title, content,
        assignee_id, assignee_username,
        creator_id,  creator_username,
        due_days, status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING
        id, title, content,
        assignee_id, assignee_username,
        creator_id,  creator_username,
        due_days, status, created_at
      `,
      [title, content, assigneeId, assigneeUsername, creatorId, creatorUsername, dueDays, status]
    );

    const row = r.rows?.[0] || null;
    return res.status(201).json({ ok: true, data: row });
  } catch (err) {
    console.error("[reminders] create error:", err);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

module.exports = router;
