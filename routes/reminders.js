// routes/reminders.js
"use strict";
const express = require("express");
const router = express.Router();

/**
 * 穩定版路由（可直接上線）：
 * - 自動偵測 DB 模組；找不到也不 500（stub mode）
 * - Admin：可看全部；非 Admin：只看自己（後端真正限制）
 * - reminder 表不存在：GET 會回空資料（不爆炸）
 *
 * ✅ 本次修正：
 * - 新增 PATCH /:id 與 PUT /:id（支援前端編輯/完成）
 * - 後端權限控制：非 admin 僅可更新「指派給自己」或「自己建立」的提醒
 * - status 支援 open/done（前端用 done 可直接成功）
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
      if (mod?.query) {
        db = mod;
        break;
      }
      if (mod?.pool?.query) {
        db = { query: mod.pool.query.bind(mod.pool) };
        break;
      }
      if (mod?.default?.query) {
        db = mod.default;
        break;
      }
    } catch (_) {}
  }
  console.log(`[reminders] DB module ${db ? "resolved" : "NOT FOUND (stub mode)"}`);
})();

// -----------------------------
// 小工具
// -----------------------------
function isAdminUser(me) {
  return !!me && (me.role === "admin" || me.is_admin === true);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function normalizeStrOrNull(v) {
  if (v === undefined) return undefined; // 代表「不更新」
  if (v === null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" ? null : s;
  }
  // 其他型別不接受（避免把 object/number 塞進 text 欄位）
  throw new Error("INVALID_STRING_FIELD");
}

function normalizeStatus(v) {
  if (v === undefined) return undefined;
  const s = String(v || "").trim().toLowerCase();
  if (!s) throw new Error("INVALID_STATUS");
  if (!["open", "done"].includes(s)) {
    throw new Error("INVALID_STATUS");
  }
  return s;
}

function normalizeDueDays(v) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error("INVALID_DUE_DAYS");
  return n;
}

/**
 * 取得提醒（用於更新/權限判斷）
 * - 若 reminder 表不存在或查不到 → 回 null
 */
async function getReminderById(id) {
  if (!db) return null;
  try {
    const r = await db.query(
      `
      SELECT
        id, title, content,
        assignee_id, assignee_username,
        creator_id,  creator_username,
        due_days, status, created_at
      FROM reminder
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );
    return r.rows?.[0] || null;
  } catch (e) {
    // 表不存在等狀況：當作不存在
    return null;
  }
}

/* =========================================
 * GET /persons
 * - Admin：全部
 * - 一般：只有自己
 * - display_name = COALESCE(NULLIF(TRIM(name), ''), username)
 * - open_count 來自 reminder.status='open'
 * - next_due 以 created_at + due_days（最早到期）估算
 * ========================================= */
router.get("/persons", async (req, res) => {
  const me = req.user || null;
  const isAdmin = isAdminUser(me);

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
        const r = await db.query(
          `
          SELECT
            id,
            username,
            COALESCE(NULLIF(TRIM(name), ''), username) AS display_name
          FROM "user"
          WHERE id = $1
          LIMIT 1
        `,
          [me.id]
        );
        users = r.rows || [];
      }
    } else {
      // 沒 DB：安全回傳
      if (!isAdmin && me?.id) {
        users = [
          {
            id: me.id,
            username: me.username,
            display_name: me.name || me.username,
          },
        ];
      } else {
        users = [];
      }
    }

    // 2) 統計 open_count + next_due（若沒有 reminder 表，忽略）
    const statMap = new Map();
    if (db) {
      try {
        const s = await db.query(`
          SELECT
            r.assignee_id,
            COUNT(*) FILTER (WHERE r.status = 'open') AS open_count,
            MIN(r.created_at + (r.due_days * interval '1 day')) FILTER
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
        // reminder 表不存在或欄位不齊 → 忽略
      }
    }

    // 3) 組輸出
    const data = (users || []).map((u) => ({
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
 * - Admin：看全部
 * - 非 Admin：只看自己（assignee_id = me.id）
 * ========================================= */
router.get("/", async (req, res) => {
  const me = req.user || null;
  const isAdmin = isAdminUser(me);

  const status = String(req.query.status || "open").toLowerCase();
  try {
    if (!db) return res.json({ ok: true, data: [] });

    // 非 admin：必須登入，且只看自己
    if (!isAdmin) {
      if (!me?.id) return res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" });
    }

    const arg = status === "all" ? "all" : status;

    // admin：不加 assignee 限制
    // 非 admin：加 assignee_id = me.id
    const sql = isAdmin
      ? `
        SELECT
          id, title, content,
          assignee_id, assignee_username,
          creator_id,  creator_username,
          due_days, status, created_at
        FROM reminder
        WHERE ($1 = 'all') OR (status = $1)
        ORDER BY created_at ASC, id ASC
      `
      : `
        SELECT
          id, title, content,
          assignee_id, assignee_username,
          creator_id,  creator_username,
          due_days, status, created_at
        FROM reminder
        WHERE (assignee_id = $2)
          AND ( ($1 = 'all') OR (status = $1) )
        ORDER BY created_at ASC, id ASC
      `;

    const params = isAdmin ? [arg] : [arg, me.id];
    const r = await db.query(sql, params);
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
 * ========================================= */
router.post("/", async (req, res) => {
  try {
    const me = req.user || null;
    if (!me?.id) return res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" });
    if (!db) return res.status(500).json({ ok: false, error: "DB_NOT_AVAILABLE" });

    let { title = null, content = null, assignee_id, due_days, status = "open" } = req.body || {};
    const assigneeId = Number(assignee_id);
    const dueDays = Number(due_days);

    if (!Number.isInteger(assigneeId) || assigneeId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_ASSIGNEE" });
    }
    if (!Number.isInteger(dueDays) || dueDays < 1) {
      return res.status(400).json({ ok: false, error: "INVALID_DUE_DAYS" });
    }

    // status
    try {
      status = normalizeStatus(status) || "open";
    } catch {
      return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    }

    // title/content（允許空 => null）
    try {
      title = normalizeStrOrNull(title);
      content = normalizeStrOrNull(content);
    } catch {
      return res.status(400).json({ ok: false, error: "INVALID_BODY" });
    }

    // 反查被指派者 username（查不到也允許）
    let assigneeUsername = null;
    try {
      const q = await db.query(`SELECT username FROM "user" WHERE id = $1`, [assigneeId]);
      assigneeUsername = q.rows?.[0]?.username || null;
    } catch (_) {}

    // 建立者
    const creatorId = me.id ?? null;
    const creatorUsername = me.username ?? null;

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

/* =========================================
 * PATCH /:id   &   PUT /:id
 * 更新提醒（支援前端：編輯儲存、完成）
 *
 * body 可包含（任意組合，未提供的欄位不變）：
 *   - title: string|null
 *   - content: string|null
 *   - due_days: number (>=1)
 *   - status: 'open'|'done'
 *
 * 權限：
 *   - admin：可更新任何提醒
 *   - 非 admin：只能更新「指派給自己」或「自己建立」的提醒
 * ========================================= */
async function updateReminderHandler(req, res) {
  const me = req.user || null;
  const isAdmin = isAdminUser(me);

  try {
    if (!me?.id) return res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" });
    if (!db) return res.status(500).json({ ok: false, error: "DB_NOT_AVAILABLE" });

    const reminderId = Number(req.params.id);
    if (!Number.isInteger(reminderId) || reminderId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_ID" });
    }

    const existing = await getReminderById(reminderId);
    if (!existing) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    // 權限（後端真正限制）
    if (!isAdmin) {
      const can =
        Number(existing.assignee_id) === Number(me.id) ||
        (existing.creator_id != null && Number(existing.creator_id) === Number(me.id));
      if (!can) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const body = req.body || {};

    // 只在 body 明確帶入時才更新
    let title, content, dueDays, status;

    try {
      if (hasOwn(body, "title")) title = normalizeStrOrNull(body.title);
      if (hasOwn(body, "content")) content = normalizeStrOrNull(body.content);
      if (hasOwn(body, "due_days")) dueDays = normalizeDueDays(body.due_days);
      if (hasOwn(body, "status")) status = normalizeStatus(body.status);
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg === "INVALID_DUE_DAYS") return res.status(400).json({ ok: false, error: "INVALID_DUE_DAYS" });
      if (msg === "INVALID_STATUS") return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
      return res.status(400).json({ ok: false, error: "INVALID_BODY" });
    }

    const sets = [];
    const params = [];
    let i = 1;

    if (title !== undefined) {
      sets.push(`title = $${i++}`);
      params.push(title);
    }
    if (content !== undefined) {
      sets.push(`content = $${i++}`);
      params.push(content);
    }
    if (dueDays !== undefined) {
      sets.push(`due_days = $${i++}`);
      params.push(dueDays);
    }
    if (status !== undefined) {
      sets.push(`status = $${i++}`);
      params.push(status);
    }

    // 沒有任何可更新欄位：直接回傳現況（不報錯）
    if (sets.length === 0) {
      return res.json({ ok: true, data: existing });
    }

    params.push(reminderId);

    const sql = `
      UPDATE reminder
      SET ${sets.join(", ")}
      WHERE id = $${i}
      RETURNING
        id, title, content,
        assignee_id, assignee_username,
        creator_id,  creator_username,
        due_days, status, created_at
    `;

    const r = await db.query(sql, params);
    const updated = r.rows?.[0] || null;
    return res.json({ ok: true, data: updated });
  } catch (err) {
    console.error("[reminders] update error:", err);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
}

router.patch("/:id", express.json(), updateReminderHandler);
router.put("/:id", express.json(), updateReminderHandler);

module.exports = router;
