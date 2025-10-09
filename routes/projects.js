// 處理專案project

const { Router } = require("express");
const dayjs = require("dayjs");
const { pool } = require("../db");

// routes/auth.js 裡加的 middleware
const auth = require("./auth");

const router = Router();

// 全域套用：先還原 req.user，再強制驗證登入
router.use(auth.attachUser);
router.use(auth.requireAuth);


/** 讓空字串 -> null，前端容易丟 "" 進來 */
function toNull(v) { return (v === "" || v === undefined) ? null : v }


// 後端統一計算到期日
function calcDueDate(start_date, estimated_days) {
  if (!start_date || !estimated_days) return null;
  const d = dayjs(start_date);
  if (!d.isValid()) return null;
  const days = Number(estimated_days);
  if (!Number.isFinite(days) || days <= 0) return null;
  return d.add(days, "day").format("YYYY-MM-DD");
}

// 新增專案 API
router.post("/projects", async (req, res) => {
  try {
    const me = req.user; // { id, username, role: 'admin' | 'member' }

    // 先把 body 取出來（此時才有 creator_user_id / creator_user_name 可用）
    const {
      project_id,             // 必填
      name,                   // 必填
      stage_id,               // 必填（0=等待,1=設計,2=施工）
      start_date,             // stage_id為1或2時，必填
      estimated_days,         // stage_id為1或2時，必填
      responsible_user_id,    // 可空
      responsible_user_name,  // 可空
      creator_user_id,        // 前端帶；若沒帶，下面會用 name/username 反查
      creator_user_name       // 可空（備援查 id 用）
    } = req.body || {};

    // 先把 stage 驗好
    const stageIdNum = Number(stage_id);
    if (!project_id || !name || !Number.isFinite(stageIdNum)) {
      return res.status(400).json({
        ok: false,
        code: "BAD_REQUEST",
        message: "缺少必填欄位(project_id/name/stage_id)"
      });
    }

    // 非 admin：無論前端傳什麼，一律只允許顯示指派給自己的專案
    let finalResponsibleUserId = (me.role === "admin")
      ? (responsible_user_id === "" || responsible_user_id == null ? null : Number(responsible_user_id))
      : me.id;


    // 設計/施工階段必填 start_date / estimated_days且有效
    if (stageIdNum === 1 || stageIdNum === 2) {
      if (!start_date || !dayjs(start_date).isValid()) {
        return res.status(400).json({
          ok: false,
          code: "REQUIRE_START_DATE",
          message: "階段為設計或施工時，開始日 必填且需為有效日期(YYYY-MM-DD)"
        });
      }
      if (!Number.isFinite(Number(estimated_days)) || Number(estimated_days) <= 0) {
        return res.status(400).json({
          ok: false,
          code: "REQUIRE_ESTIMATED_DAYS",
          message: "階段為設計或施工時，工期天數 必填且必須為正整數"
        });
      }
    }

    // 正規化欄位
    const _start_date = (start_date === "" || start_date === undefined) ? null : start_date;
    const _estimated_days =
      (estimated_days === "" || estimated_days === undefined || estimated_days === null)
        ? null : Number(estimated_days);
    const _due_date = calcDueDate(_start_date, _estimated_days);
    const _responsible_user_id =
      (responsible_user_id === "" || responsible_user_id === undefined || responsible_user_id === null)
        ? null : Number(responsible_user_id);
    const _responsible_user_name = toNull(responsible_user_name);
    const _creator_user_name = toNull(creator_user_name);


    const sql = `
      INSERT INTO project
      (project_id, name, stage_id, start_date, estimated_days, due_date,
       responsible_user_id, responsible_user_name, creator_user_id, creator_user_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id, project_id, name, stage_id, start_date, estimated_days, due_date,
                responsible_user_id, responsible_user_name, creator_user_id, creator_user_name, created_at, updated_at
    `;

    const params = [
      String(project_id),
      String(name),
      stageIdNum,
      _start_date,
      _estimated_days,
      _due_date,
      finalResponsibleUserId,
      _responsible_user_name,
      me.id,            // 用算好的 creatorId，而不是 _creator_user_id
      me.username
    ];

    const { rows } = await pool.query(sql, params);
    return res.status(201).json({ ok: true, data: rows[0] });

  } catch (err) {
    console.error("[POST /api/projects] failed:", err);
    if (err.code === '23505') { // PostgreSQL unique_violation
      return res.status(409).json({ ok: false, code: 'DUPLICATE', message: '此編號已存在' });
    }
    return res.status(500).json({
      ok: false,
      code: err.code || "INTERNAL_ERROR",
      message: err.detail || err.message || "Create failed"
    });
  }
});


// 取得列表 API
router.get("/projects", async (req, res) => {
  try {
    const me = req.user;
    let sql = `SELECT * FROM project`;
    const params = [];
    if (me.role !== "admin") {
      sql += ` WHERE responsible_user_id = $1`;
      params.push(me.id);
    }
    sql += ` ORDER BY created_at DESC LIMIT 200`;
    const { rows } = await pool.query(sql, params);
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error("[GET /api/projects] failed:", err);
    res.status(500).json({ ok: false, code: err.code || "INTERNAL_ERROR", message: err.message });
  }
});


// 取得單筆專案資料(之後篩選可用)
router.get("/projects/:id", async (req, res) => {
  try {
    const me = req.user;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, msg: "bad id" });

    const { rows } = await pool.query(`SELECT * FROM project WHERE id=$1`, [id]);
    if (rows.length === 0) return res.status(404).json({ ok: false, msg: "not found" });

    const row = rows[0];
    if (me.role !== "admin" && row.responsible_user_id !== me.id) {
      return res.status(403).json({ ok: false, msg: "NOT_OWNER" });
    }

    res.json({ ok: true, data: row });
  } catch (e) {
    console.error("[GET /api/projects/:id] failed:", e);
    res.status(500).json({ ok: false, msg: e.message || "Load failed" });
  }
});

// 更新專案（部分更新）
router.patch("/projects/:id", async (req, res) => {
  try {
    const me = req.user;
    const idNum = Number(req.params.id);
    if (!Number.isFinite(idNum)) {
      return res.status(400).json({ ok: false, message: "id invalid" });
    }

    // 先讀取單筆，做擁有權判斷
    const { rows: targetRows } = await pool.query(
      `SELECT id, responsible_user_id, stage_id, start_date, estimated_days FROM project WHERE id=$1`,
      [idNum]
    );
    if (targetRows.length === 0) return res.status(404).json({ ok: false, message: "專案不存在" });
    const target = targetRows[0];

    if (me.role !== "admin" && target.responsible_user_id !== me.id) {
      return res.status(403).json({ ok: false, message: "NOT_OWNER" });
    }

    // 正規化 patch
    const raw = req.body || {};
    const patch = {
      name: raw.name ?? undefined,
      stage_id: raw.stage_id !== undefined ? Number(raw.stage_id) : undefined,
      start_date: raw.start_date === "" ? null : raw.start_date,
      estimated_days: raw.estimated_days === "" ? null : (raw.estimated_days !== undefined ? Number(raw.estimated_days) : undefined),
      responsible_user_id: raw.responsible_user_id === "" ? null : (raw.responsible_user_id !== undefined ? Number(raw.responsible_user_id) : undefined),
    };

    // ❗ 非 admin 不允許改負責人
    if (me.role !== "admin") {
      delete patch.responsible_user_id;
    }

    const next_stage_id = patch.stage_id !== undefined ? patch.stage_id : target.stage_id;
    const next_start_date = patch.start_date !== undefined ? patch.start_date : target.start_date;
    const next_estimated_days = patch.estimated_days !== undefined ? patch.estimated_days : target.estimated_days;

    if (Number(next_stage_id) === 1 || Number(next_stage_id) === 2) {
      if (!next_start_date || !dayjs(next_start_date).isValid()) {
        return res.status(400).json({
          ok: false, code: "REQUIRE_START_DATE",
          message: "階段為設計或施工時，開始日 必填且需為有效日期(YYYY-MM-DD)"
        });
      }
      if (!Number.isFinite(Number(next_estimated_days)) || Number(next_estimated_days) <= 0) {
        return res.status(400).json({
          ok: false, code: "REQUIRE_ESTIMATED_DAYS",
          message: "階段為設計或施工時，工期天數 必填且必須為正整數"
        });
      }
    }

    const next_due_date = calcDueDate(next_start_date, next_estimated_days);

    // 動態 UPDATE
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) { fields.push(`${k} = $${idx++}`); values.push(v); }
    }
    // 永遠更新 due_date 與 updated_at
    fields.push(`due_date = $${idx++}`); values.push(next_due_date);
    fields.push(`updated_at = NOW()`);

    values.push(idNum);
    const sql = `UPDATE project SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`;
    const { rows } = await pool.query(sql, values);
    if (rows.length === 0) return res.status(404).json({ ok: false, message: "專案不存在" });

    res.json({ ok: true, data: rows[0] });
  } catch (e) {
    console.error("[PATCH /api/projects/:id] failed:", e);
    res.status(500).json({ ok: false, message: e.message || "更新失敗" });
  }
});


// 刪除專案
router.delete("/projects/:id", async (req, res) => {
  try {
    const me = req.user;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, message: "id invalid" });

    // 先查擁有權
    const { rows } = await pool.query(`SELECT responsible_user_id FROM project WHERE id=$1`, [id]);
    if (rows.length === 0) return res.status(404).json({ ok: false, message: "not found" });

    if (me.role !== "admin" && rows[0].responsible_user_id !== me.id) {
      return res.status(403).json({ ok: false, message: "NOT_OWNER" });
    }

    // 硬刪（若要軟刪，改成 UPDATE ... SET deleted_at = NOW()）
    await pool.query(`DELETE FROM project WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "刪除失敗", detail: String(err) });
  }
});

module.exports = router;
