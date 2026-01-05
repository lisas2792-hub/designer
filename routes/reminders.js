// routes/reminders.js
"use strict";

const express = require("express");
const router = express.Router();

/**
 * routes/reminders.js（Production 可用，含逾期統計）
 * ============================================================================
 * 功能：
 * - GET  /api/reminders/persons
 * - GET  /api/reminders?status=open|done
 * - POST /api/reminders
 * - PATCH/PUT /api/reminders/:id
 *
 * 權限：
 * - Admin：可看/改全部
 * - 非 Admin：只能看/改「指派給自己」或「自己建立」的 reminder
 *
 * 內容規則（依你現行規格）：
 * - title 可空白（存 null）
 * - content 不可空白
 * - due_days >= 1
 *
 * 逾期統計（算在被指派人身上）：
 * - 截止日規則（你確認版）：
 *     1/5 設 1 天  => 截止日 = 1/6（含 1/6 當天都算準時）
 *   => deadline_date = DATE(created_at@Asia/Taipei) + due_days
 *
 * - 完成日只看日期（不看時間）：
 *   done_date = DATE(completed_at@Asia/Taipei)
 *
 * - 逾期條件：
 *   done_date > deadline_date  才算逾期
 *
 * - 防止重複 +1：
 *   reminder.late_counted boolean（只要算過一次就 true）
 * ============================================================================
 */

/* =============================================================================
 * 0) DB 模組自動解析（多路徑）
 * - 同時支援：
 *   A) db.query(sql, params)
 *   B) { pool }，可用 pool.connect() 做 transaction
 * ============================================================================= */
let db = null;       // { query, pool? }
let pool = null;     // pg.Pool (optional)

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

      // case 1: mod.query
      if (mod?.query && typeof mod.query === "function") {
        db = { query: mod.query.bind(mod) };
        // 若 mod 其實就是 pool，也可能有 connect
        if (typeof mod.connect === "function") pool = mod;
        break;
      }

      // case 2: mod.pool.query
      if (mod?.pool?.query && typeof mod.pool.query === "function") {
        db = { query: mod.pool.query.bind(mod.pool), pool: mod.pool };
        pool = mod.pool;
        break;
      }

      // case 3: mod.default.query
      if (mod?.default?.query && typeof mod.default.query === "function") {
        db = { query: mod.default.query.bind(mod.default) };
        if (mod.default.pool && typeof mod.default.pool.connect === "function") {
          pool = mod.default.pool;
          db.pool = mod.default.pool;
        }
        break;
      }
    } catch (_) {}
  }

  console.log(`[reminders] DB module ${db ? "resolved" : "NOT FOUND (stub mode)"}`);
})();

/* =============================================================================
 * 1) 小工具
 * ============================================================================= */
const TZ = "Asia/Taipei";

function isAdminUser(me) {
  return !!me && (me.role === "admin" || me.is_admin === true);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

/**
 * 可選字串欄位（title 用）：
 * - undefined：代表「沒帶」=> 不更新
 * - ""：轉成 null
 * - 非字串：丟 INVALID_STRING_FIELD
 */
function normalizeStrOrNull(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" ? null : s;
  }
  throw new Error("INVALID_STRING_FIELD");
}

/**
 * 必填字串欄位（content 用）：
 * - undefined：由呼叫端決定（POST 視為缺少必填；PATCH/PUT 視為不更新）
 * - null / "" / 全空白：丟 REQUIRED_STRING_EMPTY
 * - 非字串：丟 INVALID_STRING_FIELD
 */
function normalizeRequiredStr(v) {
  if (v === undefined) return undefined;
  if (v === null) throw new Error("REQUIRED_STRING_EMPTY");
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") throw new Error("REQUIRED_STRING_EMPTY");
    return s;
  }
  throw new Error("INVALID_STRING_FIELD");
}

function normalizeStatus(v) {
  if (v === undefined) return undefined;
  const s = String(v || "").trim().toLowerCase();
  if (!s) throw new Error("INVALID_STATUS");
  if (!["open", "done"].includes(s)) throw new Error("INVALID_STATUS");
  return s;
}

function normalizeDueDays(v) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error("INVALID_DUE_DAYS");
  return n;
}

function userMessageFromError(err) {
  const code = String(err?.message || err || "");

  // 你也可以依你習慣擴充更多 mapping
  switch (code) {
    case "NOT_LOGIN":
      return "未登入";
    case "FORBIDDEN":
      return "沒有權限";
    case "REMINDER_NOT_FOUND":
      return "找不到此事務";
    case "INVALID_DUE_DAYS":
      return "期限天數需為正整數且 ≥ 1";
    case "INVALID_STATUS":
      return "狀態不正確（僅支援 open / done）";
    case "REQUIRED_STRING_EMPTY":
      return "內容不可為空";
    case "INVALID_STRING_FIELD":
      return "欄位格式不正確";
    default:
      return "系統錯誤或資料不完整";
  }
}

/* =============================================================================
 * 2) 取得單筆 reminder（用於更新/權限判斷）
 * ============================================================================= */
async function getReminderById(id) {
  if (!db) return null;
  try {
    const r = await db.query(
      `
      SELECT
        id,
        title,
        content,
        assignee_id,
        assignee_username,
        creator_id,
        creator_username,
        due_days,
        status,
        created_at,
        completed_at,
        late_counted
      FROM reminder
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );
    return r.rows?.[0] || null;
  } catch (_) {
    return null; // 表不存在等狀況：當作不存在
  }
}

/* =============================================================================
 * 3) 逾期統計核心（完成 done 時呼叫）
 *
 * 你要的規則：
 * - 截止日 = DATE(created_at@TZ) + due_days
 * - 完成日 = DATE(completed_at@TZ)
 * - done_date > deadline_date 才算逾期
 * - 同一提醒只 +1 一次（late_counted）
 *
 * 實作策略：
 * - 若有 pool.connect()：用 transaction + FOR UPDATE 最穩
 * - 若沒有：退回 single SQL（CTE）也能避免重複 +1（靠 late_counted）
 * ============================================================================= */

/** 取得 username（優先用 reminder.assignee_username；不夠再查 user 表） */
async function resolveAssigneeUsername(clientOrDb, assigneeId, fallbackUsername) {
  if (fallbackUsername && String(fallbackUsername).trim()) return String(fallbackUsername).trim();
  if (!clientOrDb?.query) return `user${assigneeId}`;

  try {
    const r = await clientOrDb.query(
      `SELECT username FROM "user" WHERE id = $1 LIMIT 1`,
      [assigneeId]
    );
    const u = r.rows?.[0]?.username;
    return (u && String(u).trim()) ? String(u).trim() : `user${assigneeId}`;
  } catch (_) {
    return `user${assigneeId}`;
  }
}

/** 有 pool 時：transaction 版（最穩） */
async function markDoneAndCountLateTx(reminderId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) 鎖住 reminder
    const r0 = await client.query(
      `
      SELECT
        id, status, created_at, due_days, assignee_id, assignee_username,
        completed_at, late_counted
      FROM reminder
      WHERE id = $1
      FOR UPDATE
      `,
      [reminderId]
    );
    if (r0.rowCount === 0) throw new Error("REMINDER_NOT_FOUND");

    const before = r0.rows[0];
    if (before.status === "done") {
      await client.query("COMMIT");
      return { ok: true, alreadyDone: true };
    }

    // 2) 寫入 done + completed_at（只寫一次）
    const r1 = await client.query(
      `
      UPDATE reminder
      SET
        status = 'done',
        completed_at = COALESCE(completed_at, now())
      WHERE id = $1
      RETURNING
        id, created_at, due_days, assignee_id, assignee_username, completed_at, late_counted
      `,
      [reminderId]
    );
    const after = r1.rows[0];

    // 3) 只比日期（Asia/Taipei）
    //    deadline_date = DATE(created_at@TZ) + due_days    ✅ 不 -1（符合你定義）
    //    done_date     = DATE(completed_at@TZ)
    const r2 = await client.query(
      `
      SELECT
        ((($1 AT TIME ZONE $3)::date + $2::int)) AS deadline_date,
        (( $4 AT TIME ZONE $3)::date)           AS done_date
      `,
      [after.created_at, after.due_days, TZ, after.completed_at]
    );

    const { deadline_date, done_date } = r2.rows[0];
    const isLate = (done_date > deadline_date);

    // 4) 逾期 + 尚未計入 => metrics +1，並把 late_counted 設 true
    if (isLate && after.late_counted === false) {
      const assigneeUsername = await resolveAssigneeUsername(
        client,
        after.assignee_id,
        after.assignee_username
      );

      await client.query(
        `
        INSERT INTO reminder_assignee_metrics (
          assignee_id,
          assignee_username,
          late_done_count,
          updated_at
        )
        VALUES ($1, $2, 1, now())
        ON CONFLICT (assignee_id)
        DO UPDATE SET
          late_done_count = reminder_assignee_metrics.late_done_count + 1,
          assignee_username = EXCLUDED.assignee_username,
          updated_at = now()
        `,
        [after.assignee_id, assigneeUsername]
      );

      await client.query(
        `UPDATE reminder SET late_counted = true WHERE id = $1`,
        [reminderId]
      );
    }

    await client.query("COMMIT");
    return { ok: true, isLate, deadline_date, done_date };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** 沒 pool 時：CTE 原子版（仍可避免重複 +1） */
async function markDoneAndCountLateAtomic(reminderId) {
  if (!db) throw new Error("DB_NOT_READY");

  // 這個 SQL 做的事：
  // - 先把 reminder status 改 done + completed_at
  // - 以日期計算 isLate（只比日期）
  // - 只有在 isLate 且 late_counted=false 時：
  //   - metrics +1（INSERT ON CONFLICT UPDATE）
  //   - reminder.late_counted = true
  //
  // 重要：WHERE late_counted=false 確保同一筆不會重複 +1（即使重送 PATCH）
  const sql = `
    WITH updated AS (
      UPDATE reminder
      SET
        status = 'done',
        completed_at = COALESCE(completed_at, now())
      WHERE id = $1
        AND status <> 'done'
      RETURNING
        id,
        created_at,
        due_days,
        assignee_id,
        assignee_username,
        completed_at,
        late_counted
    ),
    calc AS (
      SELECT
        u.*,
        ((u.created_at AT TIME ZONE $2)::date + u.due_days::int) AS deadline_date,
        ((u.completed_at AT TIME ZONE $2)::date)                 AS done_date
      FROM updated u
    ),
    late AS (
      SELECT *
      FROM calc
      WHERE (done_date > deadline_date) AND late_counted = false
    ),
    upsert_metrics AS (
      INSERT INTO reminder_assignee_metrics (
        assignee_id, assignee_username, late_done_count, updated_at
      )
      SELECT
        l.assignee_id,
        COALESCE(NULLIF(TRIM(l.assignee_username), ''), 'user' || l.assignee_id::text),
        1,
        now()
      FROM late l
      ON CONFLICT (assignee_id)
      DO UPDATE SET
        late_done_count = reminder_assignee_metrics.late_done_count + 1,
        assignee_username = EXCLUDED.assignee_username,
        updated_at = now()
      RETURNING assignee_id
    )
    UPDATE reminder r
    SET late_counted = true
    WHERE r.id IN (SELECT id FROM late)
    RETURNING
      r.id;
  `;

  // 注意：atomic 版不容易回傳 deadline/done 日期（你要也可以再查一次）
  await db.query(sql, [reminderId, TZ]);
  return { ok: true };
}

/** 統一入口：先走 tx（有 pool）否則 atomic */
async function markDoneAndCountLate(reminderId) {
  if (pool && typeof pool.connect === "function") {
    return await markDoneAndCountLateTx(reminderId);
  }
  return await markDoneAndCountLateAtomic(reminderId);
}

/* =============================================================================
 * 4) GET /persons
 * - Admin：全部人
 * - 非 Admin：只有自己
 * - open_count：reminder.status='open'
 * - next_due：created_at + due_days days（符合你 due_days=1 => 明天）
 * ============================================================================= */
router.get("/persons", async (req, res) => {
  const me = req.user || null;
  const isAdmin = isAdminUser(me);

  try {
    let users = [];

    if (!db) {
      // stub mode
      if (!isAdmin && me?.id) {
        users = [{
          id: me.id,
          username: me.username,
          display_name: me.name || me.username,
        }];
      }
      return res.json({ ok: true, data: users.map(u => ({ ...u, open_count: 0, next_due: null })) });
    }

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

    // open_count + next_due
    const statMap = new Map();
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
      // reminder 表不存在或欄位不齊：忽略
    }

    const data = users.map(u => {
      const st = statMap.get(Number(u.id)) || { open_count: 0, next_due: null };
      return { ...u, ...st };
    });

    return res.json({ ok: true, data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: userMessageFromError(err) });
  }
});

/* =============================================================================
 * 5) GET /
 * - status=open|done（可選）
 * - Admin：全部；非 Admin：只看自己（assignee_id=me.id 或 creator_id=me.id）
 * ============================================================================= */
router.get("/", async (req, res) => {
  const me = req.user || null;
  const isAdmin = isAdminUser(me);

  const status = (req.query.status ? String(req.query.status).trim().toLowerCase() : "");
  const statusFilter = (status && ["open", "done"].includes(status)) ? status : "";

  try {
    if (!db) return res.json({ ok: true, data: [] });

    const where = [];
    const params = [];

    if (statusFilter) {
      params.push(statusFilter);
      where.push(`r.status = $${params.length}`);
    }

    if (!isAdmin) {
      if (!me?.id) return res.json({ ok: true, data: [] });
      params.push(me.id);
      where.push(`(r.assignee_id = $${params.length} OR r.creator_id = $${params.length})`);
    }

    const sql = `
      SELECT
        r.id,
        r.title,
        r.content,
        r.assignee_id,
        r.assignee_username,
        r.creator_id,
        r.creator_username,
        r.due_days,
        r.status,
        r.created_at,
        r.completed_at,
        r.late_counted
      FROM reminder r
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY r.created_at DESC, r.id DESC
    `;

    const r = await db.query(sql, params);
    return res.json({ ok: true, data: r.rows || [] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: userMessageFromError(err) });
  }
});

/* =============================================================================
 * 6) POST /
 * - Admin：可新增給任何人
 * - 非 Admin：建議仍允許（依你既有邏輯），但至少要有 me
 * 必填：content, assignee_id, due_days
 * 可選：title
 * ============================================================================= */
router.post("/", async (req, res) => {
  const me = req.user || null;
  const isAdmin = isAdminUser(me);

  try {
    if (!db) return res.status(503).json({ ok: false, error: "資料庫未就緒" });

    const title = normalizeStrOrNull(req.body?.title);
    const content = normalizeRequiredStr(req.body?.content); // POST 必填
    const dueDays = normalizeDueDays(req.body?.due_days);
    const assigneeId = Number(req.body?.assignee_id);

    if (!Number.isInteger(assigneeId) || assigneeId <= 0) {
      throw new Error("INVALID_ASSIGNEE");
    }

    // creator
    const creatorId = me?.id || null;
    const creatorUsername = me?.username || null;

    // assignee_username：盡量查 user 表（若查不到就 fallback）
    const assigneeUsername = await resolveAssigneeUsername(db, assigneeId, req.body?.assignee_username);

    const r = await db.query(
      `
      INSERT INTO reminder (
        title,
        content,
        assignee_id,
        assignee_username,
        creator_id,
        creator_username,
        due_days,
        status,
        created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,'open', now())
      RETURNING
        id, title, content, assignee_id, assignee_username,
        creator_id, creator_username, due_days, status, created_at
      `,
      [title ?? null, content, assigneeId, assigneeUsername, creatorId, creatorUsername, dueDays]
    );

    return res.json({ ok: true, data: r.rows?.[0] || null });
  } catch (err) {
    console.error(err);
    const msg = userMessageFromError(err);
    return res.status(400).json({ ok: false, error: msg });
  }
});

/* =============================================================================
 * 7) PATCH/PUT /:id
 * - 可更新：title（可空）、content（若有帶必須非空）、due_days、status、assignee_id
 * - status=done 時：觸發「逾期統計」與 completed_at/late_counted
 * ============================================================================= */
async function updateReminder(req, res) {
  const me = req.user || null;
  const isAdmin = isAdminUser(me);
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: "ID 不正確" });
  }

  try {
    if (!db) return res.status(503).json({ ok: false, error: "資料庫未就緒" });

    const current = await getReminderById(id);
    if (!current) throw new Error("REMINDER_NOT_FOUND");

    // 權限：非 admin 必須是指派給自己 or 自己建立
    if (!isAdmin) {
      if (!me?.id) throw new Error("NOT_LOGIN");
      const ok = (Number(current.assignee_id) === Number(me.id)) || (Number(current.creator_id) === Number(me.id));
      if (!ok) throw new Error("FORBIDDEN");
    }

    // 解析 payload（PATCH/PUT：沒帶就不更新）
    const patch = {};

    if (hasOwn(req.body, "title")) {
      patch.title = normalizeStrOrNull(req.body.title); // 可空 => null
    }
    if (hasOwn(req.body, "content")) {
      patch.content = normalizeRequiredStr(req.body.content); // 有帶就必須非空
    }
    if (hasOwn(req.body, "due_days")) {
      patch.due_days = normalizeDueDays(req.body.due_days);
    }
    if (hasOwn(req.body, "status")) {
      patch.status = normalizeStatus(req.body.status); // open / done
    }
    if (hasOwn(req.body, "assignee_id")) {
      const aid = Number(req.body.assignee_id);
      if (!Number.isInteger(aid) || aid <= 0) throw new Error("INVALID_ASSIGNEE");
      patch.assignee_id = aid;
      // 同步 username（避免 metrics/顯示缺值）
      patch.assignee_username = await resolveAssigneeUsername(db, aid, req.body?.assignee_username);
    }

    // 沒任何可更新欄位
    const keys = Object.keys(patch);
    if (keys.length === 0) {
      return res.json({ ok: true, data: current });
    }

    // 先做一般欄位更新（非 status=done 的特殊邏輯）
    // 注意：status=done 會再走 markDoneAndCountLate，避免邏輯分散。
    const normalFields = [];
    const params = [];
    let idx = 0;

    // title/content/due_days/assignee_id/assignee_username/status(open) 可以直接更新
    // 若 status=done，先不在這裡做（等下交給 markDoneAndCountLate）
    const wantsDone = (patch.status === "done");
    const statusForNormalUpdate = wantsDone ? undefined : patch.status;

    const mapping = [
      ["title", patch.title],
      ["content", patch.content],
      ["due_days", patch.due_days],
      ["assignee_id", patch.assignee_id],
      ["assignee_username", patch.assignee_username],
      ["status", statusForNormalUpdate],
    ];

    for (const [col, val] of mapping) {
      if (val === undefined) continue;
      params.push(val);
      idx += 1;
      normalFields.push(`${col} = $${idx}`);
    }

    let updatedRow = current;

    if (normalFields.length > 0) {
      params.push(id);
      const r = await db.query(
        `
        UPDATE reminder
        SET ${normalFields.join(", ")}
        WHERE id = $${params.length}
        RETURNING
          id, title, content, assignee_id, assignee_username,
          creator_id, creator_username, due_days, status, created_at,
          completed_at, late_counted
        `,
        params
      );
      updatedRow = r.rows?.[0] || updatedRow;
    }

    // 如果這次是要完成(done)：走「逾期統計」入口
    if (wantsDone) {
      await markDoneAndCountLate(id);

      // 回傳最新資料（含 completed_at/late_counted）
      const latest = await getReminderById(id);
      return res.json({ ok: true, data: latest || updatedRow });
    }

    return res.json({ ok: true, data: updatedRow });
  } catch (err) {
    console.error(err);
    const msg = userMessageFromError(err);
    const status = (String(err?.message || "") === "FORBIDDEN") ? 403
      : (String(err?.message || "") === "REMINDER_NOT_FOUND") ? 404
      : 400;
    return res.status(status).json({ ok: false, error: msg });
  }
}

router.patch("/:id", updateReminder);
router.put("/:id", updateReminder);

module.exports = router;
