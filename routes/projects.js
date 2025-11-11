// routes/projects.js
"use strict";

/**
 * ★ 本檔只保留路由／驗證／流程控制
 * ★ 所有 SQL 已移至 repositories/projectRepo.js 與 repositories/userRepo.js
 */

const { Router } = require("express");
const dayjs = require("dayjs");
const { pool } = require("../db");
// const { requireAuth } = require("../middleware/auth"); // ← server.js 已包住 /api，不必再加

const {
  insertProject,
  listProjects,
  getProjectById,
  getProjectForPatch,
  updateProjectDynamic,
  deleteProjectById,
} = require("../repositories/projectRepo");

const {
  getActiveUserById,
  findUserIdByNameOrUsername,
  getUserNameById,
} = require("../repositories/userRepo");

const router = Router();

/** 統一把空字串 -> null（前端常丟 "" 進來） */
function toNull(v) {
  return v === "" || v === undefined ? null : v;
}

/** 後端統一計算到期日 */
function calcDueDate(start_date, estimated_days) {
  if (!start_date || !estimated_days) return null;
  const d = dayjs(start_date);
  if (!d.isValid()) return null;
  const days = Number(estimated_days);
  if (!Number.isFinite(days) || days <= 0) return null;
  return d.add(days, "day").format("YYYY-MM-DD");
}

/** 角色是否為管理員 */
function isAdminRole(role) {
  if (!role) return false;
  const r = String(role).toLowerCase();
  return new Set(["admin", "system", "superadmin", "owner"]).has(r);
}

/** -------------------------------------------
 *  POST /api/projects  建立專案
 *  （注意：此 router 被掛在 /api/projects）
 *  → 這裡的路徑寫 "/" 就是 /api/projects
 * ------------------------------------------- */
router.post("/", /* requireAuth,*/ async (req, res) => {
  const client = await pool.connect();
  try {
    console.log("[REQ BODY POST /api/projects]", JSON.stringify(req.body, null, 2));

    const {
      project_id,
      name,
      stage_id,
      start_date,
      estimated_days,
      responsible_user_id,
      creator_user_id, // 一般從 req.user.id 來，這裡保留相容
    } = req.body || {};

    const stageIdNum = Number(stage_id);
    if (!project_id || !name || !Number.isFinite(stageIdNum)) {
      return res.status(400).json({
        ok: false,
        code: "BAD_REQUEST",
        message: "缺少必填欄位(project_id/name/stage_id)",
      });
    }

    // ★ 若前端沒送 creator_user_id，就用登入者
    let creatorId = Number(creator_user_id);
    if (!Number.isFinite(creatorId) && req.user?.id) {
      creatorId = Number(req.user.id);
    }
    if (!Number.isFinite(creatorId) && req.body?.creator_user_name) {
      const maybeId = await findUserIdByNameOrUsername(pool, req.body.creator_user_name);
      creatorId = maybeId ?? null;
    }
    if (!Number.isFinite(creatorId)) {
      return res.status(400).json({
        ok: false,
        code: "NO_CREATOR",
        message: "找不到建立者（未登入或無法解析使用者）",
      });
    }

    await client.query("BEGIN");

    const creator = await getActiveUserById(client, creatorId);
    if (!creator) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        code: "CREATOR_NOT_FOUND",
        message: "建立者不存在或未啟用",
      });
    }
    const creatorNameForDisplay = (creator.name || "").trim();
    if (!creatorNameForDisplay) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        code: "CREATOR_NAME_MISSING",
        message: "建立者姓名為空，請先補上",
      });
    }

    // ★ 解析負責人（可空）
    let respId =
      responsible_user_id === "" || responsible_user_id == null
        ? null
        : Number(responsible_user_id);
    let respNameForDisplay = null;

    if (Number.isFinite(respId)) {
      const nameRow = await getUserNameById(client, respId);
      if (nameRow && (nameRow.name || "").trim()) {
        respNameForDisplay = nameRow.name.trim();
      } else {
        respId = null;
        respNameForDisplay = null;
      }
    } else if (req.body?.responsible_user_name) {
      const maybeId = await findUserIdByNameOrUsername(client, req.body.responsible_user_name);
      if (maybeId) {
        const nameRow = await getUserNameById(client, maybeId);
        if (nameRow && (nameRow.name || "").trim()) {
          respId = maybeId;
          respNameForDisplay = nameRow.name.trim();
        }
      }
    }

    // ★ 設計/施工階段檢查
    if (stageIdNum === 1 || stageIdNum === 2) {
      if (!start_date || !dayjs(start_date).isValid()) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          code: "REQUIRE_START_DATE",
          message: "階段為設計或施工時，開始日 必填且需為有效日期(YYYY-MM-DD)",
        });
      }
      if (!Number.isFinite(Number(estimated_days)) || Number(estimated_days) <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          code: "REQUIRE_ESTIMATED_DAYS",
          message: "階段為設計或施工時，工期天數 必填且必須為正整數",
        });
      }
    }

    // ★ 正規化 + 計算到期
    const _start_date = toNull(start_date);
    const _estimated_days =
      estimated_days === "" || estimated_days == null ? null : Number(estimated_days);
    const _due_date = calcDueDate(_start_date, _estimated_days);

    const inserted = await insertProject(client, {
      project_id: String(project_id),
      name: String(name),
      stage_id: stageIdNum,
      start_date: _start_date,
      estimated_days: _estimated_days,
      due_date: _due_date,
      responsible_user_id: respId,
      responsible_user_name: respNameForDisplay, // 展示用
      creator_user_id: creatorId,
      creator_user_name: creatorNameForDisplay, // 展示用
    });

    await client.query("COMMIT");
    return res.status(201).json({ ok: true, data: inserted });
  } catch (err) {
    try { await pool.query("ROLLBACK"); } catch {}
    const snapshot = {
      code: err.code,
      constraint: err.constraint,
      detail: err.detail,
      body: {
        creator_user_id: req.body?.creator_user_id,
        creator_user_name: req.body?.creator_user_name,
        responsible_user_id: req.body?.responsible_user_id,
        responsible_user_name: req.body?.responsible_user_name,
      },
    };
    console.error("[POST /api/projects] failed (snapshot):", JSON.stringify(snapshot, null, 2));

    if (err.code === "23505") {
      return res.status(409).json({ ok: false, code: "DUPLICATE", message: "此編號已存在" });
    }
    if (err.code === "23503") {
      return res
        .status(400)
        .json({ ok: false, code: "FK_VIOLATION", message: "外鍵錯誤：請確認使用者ID存在且啟用中" });
    }
    return res
      .status(500)
      .json({ ok: false, code: err.code || "INTERNAL_ERROR", message: err.detail || err.message || "Create failed" });
  } finally {
    // 確保釋放 client（避免連線洩漏）
    try { /* client 在成功時 COMMIT 後已釋放；失敗時這裡釋放 */ client.release(); } catch {}
  }
});

/** -------------------------------------------
 *  GET /api/projects  取得列表（前 200 筆，依權限過濾）
 * ------------------------------------------- */
router.get("/", /* requireAuth,*/ async (req, res) => {
  try {
    const viewerId = Number(req.user.id);
    const admin = isAdminRole(req.user.role);
    const rows = await listProjects(pool, { viewerId, isAdmin: admin, limit: 200 });
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error("[GET /api/projects] failed:", err);
    res
      .status(500)
      .json({ ok: false, code: err.code || "INTERNAL_ERROR", message: err.message });
  }
});

/** -------------------------------------------
 *  GET /api/projects/:id  取得單筆（含權限檢查）
 * ------------------------------------------- */
router.get("/:id", /* requireAuth,*/ async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, msg: "bad id" });

    const row = await getProjectById(pool, id);
    if (!row) return res.status(404).json({ ok: false, msg: "not found" });

    const admin = isAdminRole(req.user.role);
    const viewerId = Number(req.user.id);
    if (
      !admin &&
      row.creator_user_id !== viewerId &&
      row.responsible_user_id !== viewerId
    ) {
      return res.status(403).json({ ok: false, msg: "forbidden" });
    }

    res.json({ ok: true, data: row });
  } catch (e) {
    console.error("[GET /api/projects/:id] failed:", e);
    res.status(500).json({ ok: false, msg: e.message || "Load failed" });
  }
});

/** -------------------------------------------
 *  PATCH /api/projects/:id  部分更新（自動重算 due_date）
 * ------------------------------------------- */
router.patch("/:id", /* requireAuth,*/ async (req, res) => {
  const client = await pool.connect();
  try {
    const idNum = Number(req.params.id);
    if (!Number.isFinite(idNum)) {
      return res.status(400).json({ ok: false, message: "id invalid" });
    }

    // 先讀舊資料
    const prev = await getProjectForPatch(client, idNum);
    if (!prev) return res.status(404).json({ ok: false, message: "專案不存在" });

    // （可選）權限檢查
    const admin = isAdminRole(req.user.role);
    const viewerId = Number(req.user.id);
    if (
      !admin &&
      prev.creator_user_id !== viewerId &&
      prev.responsible_user_id !== viewerId
    ) {
      return res.status(403).json({ ok: false, message: "forbidden" });
    }

    // 正規化 body
    const raw = req.body || {};
    let nextResponsibleId;
    let nextResponsibleName = undefined;

    if (raw.responsible_user_id !== undefined) {
      if (raw.responsible_user_id === "" || raw.responsible_user_id == null) {
        nextResponsibleId = null;
        nextResponsibleName = null;
      } else {
        const candidate = Number(raw.responsible_user_id);
        if (Number.isFinite(candidate)) {
          const nameRow = await getUserNameById(client, candidate);
          if (nameRow && (nameRow.name || "").trim()) {
            nextResponsibleId = candidate;
            nextResponsibleName = nameRow.name.trim();
          } else {
            nextResponsibleId = null;
            nextResponsibleName = null;
          }
        } else {
          nextResponsibleId = null;
          nextResponsibleName = null;
        }
      }
    }

    const patch = {
      name: raw.name ?? undefined,
      stage_id: raw.stage_id !== undefined ? Number(raw.stage_id) : undefined,
      start_date: raw.start_date === "" ? null : raw.start_date,
      estimated_days:
        raw.estimated_days === ""
          ? null
          : raw.estimated_days !== undefined
          ? Number(raw.estimated_days)
          : undefined,
      responsible_user_id: raw.responsible_user_id !== undefined ? nextResponsibleId : undefined,
      responsible_user_name: nextResponsibleName,
    };

    const next_stage_id =
      patch.stage_id !== undefined ? patch.stage_id : prev.stage_id;
    const next_start_date =
      patch.start_date !== undefined ? patch.start_date : prev.start_date;
    const next_estimated_days =
      patch.estimated_days !== undefined ? patch.estimated_days : prev.estimated_days;

    if (Number(next_stage_id) === 1 || Number(next_stage_id) === 2) {
      if (!next_start_date || !dayjs(next_start_date).isValid()) {
        return res.status(400).json({
          ok: false,
          code: "REQUIRE_START_DATE",
          message: "階段為設計或施工時，開始日 必填且需為有效日期(YYYY-MM-DD)",
        });
      }
      if (!Number.isFinite(Number(next_estimated_days)) || Number(next_estimated_days) <= 0) {
        return res.status(400).json({
          ok: false,
          code: "REQUIRE_ESTIMATED_DAYS",
          message: "階段為設計或施工時，工期天數 必填且必須為正整數",
        });
      }
    }

    const next_due_date = calcDueDate(next_start_date, next_estimated_days);

    const updated = await updateProjectDynamic(client, idNum, {
      ...patch,
      due_date: next_due_date,
    });

    if (!updated) return res.status(404).json({ ok: false, message: "專案不存在" });
    res.json({ ok: true, data: updated });
  } catch (e) {
    console.error("[PATCH /api/projects/:id] failed:", e);
    res.status(500).json({ ok: false, message: e.message || "更新失敗" });
  } finally {
    client.release();
  }
});

/** -------------------------------------------
 *  DELETE /api/projects/:id 刪除
 * ------------------------------------------- */
router.delete("/:id", /* requireAuth,*/ async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, message: "id invalid" });

    const row = await getProjectById(pool, id);
    if (!row) return res.status(404).json({ ok: false, message: "not found" });

    const admin = isAdminRole(req.user.role);
    const viewerId = Number(req.user.id);
    if (
      !admin &&
      row.creator_user_id !== viewerId &&
      row.responsible_user_id !== viewerId
    ) {
      return res.status(403).json({ ok: false, message: "forbidden" });
    }

    await deleteProjectById(pool, id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/projects/:id] failed:", err);
    res.status(500).json({ ok: false, message: "刪除失敗", detail: String(err) });
  }
});

module.exports = router;
