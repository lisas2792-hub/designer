// routes/stageupload.js
"use strict";

/**
 * ✅ 專業版：服務帳號 + Shared Drive（Production 推薦）
 * - Cloud Run 以「服務帳號（執行身分）」呼叫 Google Drive API
 * - 只要把該服務帳號加入 Shared Drive（內容管理員）即可
 *
 * ▶ 必要環境變數（部署時）：
 *   DRIVE_USE_SERVICE_ACCOUNT=true                          // [PROD KEEP] 強制使用服務帳號模式
 *   DRIVE_SHARED_DRIVE_ID=<你的 Shared Drive ID>            // [PROD KEEP] 提升查詢精準度
 *   GDRIVE_FOLDER_ID=<Shared Drive 裡真正要上傳的資料夾ID> // [PROD KEEP]
 *   MAX_UPLOAD_MB=20                                       // [PROD KEEP] Cloud Run 單請求 <= 32MB
 *
 * ▶ 建議環境變數（安全/診斷）：
 *   DRIVE_PUBLIC_READ=true/false // [DEV ONLY 建議 true] DEV 方便預覽；[PROD 建議不設或 false]
 *   DEV_DEBUG=true/false         // [DEV ONLY 建議 true] 額外日誌
 *
 * ▶ DB 需求：
 *   - 在 project_text_upload（或你實際表名）新增欄位 uploaded_by_name text
 *   - 你的 upsertProjectTextUpload() 需把 uploaded_by_name 一併寫入
 *
 * ▶ 認證需求：
 *   - 你既有的 attachUser / requireAuth 不變
 *   - 這份程式會從 req.user.username 反查 user.name，存到 uploaded_by_name
 *
 * ▶ 注意：
 *   - 保留「專案/階段 → 自動建資料夾」與「命名規則」
 *   - 回應結構沿用（files / cloud / cloudTarget）
 *   - 支援 Shared Drive
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { google } = require("googleapis");
const { Readable } = require("stream");

const { pool } = require("../db");
const { attachUser, requireAuth /*, requireAdmin*/ } = require("../middleware/auth"); // ← 如要保護 /__drive/diag，可打開 requireAdmin
const { upsertProjectTextUpload, getLastUpload } = require("../repositories/stageUploadRepo");

/* ================== 環境變數（統一布林處理 + 模式開關） ================== */
const asBool = (v, def = false) => {
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
};

const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";

const DEV_DEBUG = asBool(process.env.DEV_DEBUG, !IS_PROD); // Dev 預設 true / Prod 預設 false
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20);

const DRIVE_USE_SERVICE_ACCOUNT = asBool(process.env.DRIVE_USE_SERVICE_ACCOUNT, IS_PROD); // [PROD KEEP] 預設 production=true
const DRIVE_SHARED_DRIVE_ID = process.env.DRIVE_SHARED_DRIVE_ID || "";                  // [PROD KEEP] 建議設定
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID || "";                             // [PROD KEEP]

const CLOUD_TARGET = (process.env.CLOUD_TARGET || "DRIVE").toUpperCase();

// ⛳「對外公開讀取」的權限（只在 DEV 方便用）：Prod 建議關閉（不設或 false）
const DRIVE_PUBLIC_READ = asBool(process.env.DRIVE_PUBLIC_READ, false); // [DEV ONLY 建議 true] / [PROD 建議 false]

/* ================== 上傳限制 ================== */
const ALLOWED_MIME = (process.env.ALLOWED_MIME ||
  "image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,application/pdf")
  .split(",")
  .map((s) => s.trim().toLowerCase());

/* ================== 目錄與 stages.json（保留原行為） ================== */
const UPLOAD_ROOT = "/tmp/uploads"; // [PROD KEEP] Cloud Run 只能寫 /tmp；本機也 OK
const pathExists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
try { fs.mkdirSync(UPLOAD_ROOT, { recursive: true }); } catch {}

const PROJECT_ROOT = process.cwd();
const THIS_DIR = __dirname;

function findStagesJson() {
  const envPath = process.env.STAGES_JSON && path.resolve(process.env.STAGES_JSON);
  const candidates = [];
  if (envPath) candidates.push(envPath);

  candidates.push(
    path.resolve(PROJECT_ROOT, "config", "stages.json"),
    path.resolve(PROJECT_ROOT, "stages.json"),
    path.resolve(THIS_DIR, "..", "config", "stages.json"),
    path.resolve(THIS_DIR, "..", "stages.json")
  );

  for (const fp of candidates) {
    if (pathExists(fp)) return { file: fp, candidates };
  }
  return { file: envPath || path.resolve(PROJECT_ROOT, "config", "stages.json"), candidates };
}

let STAGES_JSON_INFO = findStagesJson();
let STAGES_JSON = STAGES_JSON_INFO.file;
let STAGE_MAP = {};

function decodeJsonFileSmart(fp) {
  const buf = fs.readFileSync(fp);
  let text;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.toString("utf16le");
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i < buf.length; i += 2) { swapped[i - 2] = buf[i + 1]; swapped[i - 1] = buf[i]; }
    text = swapped.toString("utf16le");
  } else {
    text = buf.toString("utf8");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}
function buildStageMapFromArray(arr) {
  const map = {};
  for (const it of arr) {
    if (typeof it === "string") {
      const id = Object.keys(map).length + 1;
      const name = it.trim();
      if (name) map[id] = name;
    } else if (it && typeof it === "object") {
      const idRaw = it.id ?? it.stage_id;
      const nameRaw = it.name ?? it.stage_name ?? it.title ?? it.label;
      const id = Number(idRaw);
      const name = String(nameRaw || "").trim();
      if (id && name) map[id] = name;
    }
  }
  return map;
}
const normalizeDigitKey = (k) => String(k).replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 0x30));
function loadStages() {
  try {
    if (!pathExists(STAGES_JSON)) {
      STAGES_JSON_INFO = findStagesJson();
      STAGES_JSON = STAGES_JSON_INFO.file;
    }
    if (!pathExists(STAGES_JSON)) {
      console.warn("[stages] 找不到 stages.json，使用預設 stage_<no>。嘗試路徑：", STAGES_JSON_INFO.candidates);
      STAGE_MAP = {};
      return;
    }
    const data = decodeJsonFileSmart(STAGES_JSON);
    const root = (data && (data.stages ?? data)) || {};
    let map = {};
    if (Array.isArray(root)) {
      map = buildStageMapFromArray(root);
    } else if (root && typeof root === "object") {
      for (const [k, v] of Object.entries(root)) {
        const idNorm = normalizeDigitKey(k);
        const id = Number(idNorm);
        const name = String(v || "").trim();
        if (Number.isFinite(id) && id > 0 && name) map[id] = name;
      }
    }
    STAGE_MAP = map;
    if (DEV_DEBUG) console.log("[stages] using file:", STAGES_JSON);
  } catch (e) {
    console.warn(`[stages] 解析失敗：`, e?.message || e);
    STAGE_MAP = {};
  }
}
loadStages();
function getStageName(stageNo) {
  const n = Number(stageNo);
  return STAGE_MAP[n] ?? STAGE_MAP[String(n)] ?? `stage_${n}`;
}

/* ================== 共用工具 ================== */
function safeSegment(s) {
  return String(s || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}
function taipeiTimestamp() {
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value || "";
  return `${get("year")}${get("month")}${get("day")}-${get("hour")}${get("minute")}${get("second")}`;
}

/* ================== Google Drive（Service Account via Metadata） ================== */
/**
 * 這裡用 GoogleAuth（無金鑰檔），Cloud Run 會自動用執行身分服務帳號
 * 請把該服務帳號加入 Shared Drive（內容管理員）
 */
const auth = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/drive.file"], // 上傳/管理本服務建立的檔案
});
function getDrive() {
  return google.drive({ version: "v3", auth });
}

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const escQ = (str = "") => String(str).replace(/(['\\])/g, "\\$1");

/** 在特定父層底下找資料夾（支援 Shared Drive） */
async function driveFindFolder(drv, name, parentId) {
  const q = [
    `mimeType='${DRIVE_FOLDER_MIME}'`,
    `name='${escQ(name)}'`,
    "trashed=false",
    parentId ? `'${escQ(parentId)}' in parents` : "",
  ].filter(Boolean).join(" and ");

  const { data } = await drv.files.list({
    q,
    fields: "files(id,name,parents)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    ...(DRIVE_SHARED_DRIVE_ID
      ? { driveId: DRIVE_SHARED_DRIVE_ID, corpora: "drive" }
      : {}), // 若有設定 Shared Drive ID，讓查詢更準
  });
  return data.files?.[0]?.id || null;
}

async function driveEnsureFolder(drv, name, parentId, appProps) {
  const existed = await driveFindFolder(drv, name, parentId);
  if (existed) return existed;
  const { data } = await drv.files.create({
    requestBody: {
      name,
      mimeType: DRIVE_FOLDER_MIME,
      parents: parentId ? [parentId] : undefined,
      appProperties: appProps || undefined,
    },
    fields: "id,name,parents",
    supportsAllDrives: true,
  });
  return data.id;
}

async function ensureProjectStageFolder(drv, rootId, projectNo, projectName, stageNo, stageName) {
  const projectFolderName = `${projectNo}_${safeSegment(projectName)}`;
  const projectFolderId = await driveEnsureFolder(drv, projectFolderName, rootId, {
    type: "project",
    projectNo: String(projectNo),
    projectName: String(projectName),
  });

  const stageFolderName = `${stageNo}_${safeSegment(stageName)}`;
  const stageFolderId = await driveEnsureFolder(drv, stageFolderName, projectFolderId, {
    type: "stage",
    projectNo: String(projectNo),
    projectName: String(projectName),
    stageNo: String(stageNo),
    stageName: String(stageName),
  });

  return { projectFolderId, stageFolderId };
}

/** 以 buffer 直傳到 Drive（Service Account） */
async function uploadBufferToDrive(buffer, originalName, mimeType, projectNo, stageNo, projectName, stageName, appProps) {
  // [PROD KEEP] 這支目前只允許 Service Account；Dev 若要 OAuth，可在此加入「另一條分支」做自動切換
  if (!DRIVE_USE_SERVICE_ACCOUNT) {
    return { ok: false, error: "Service Account 模式未啟用（請設定 DRIVE_USE_SERVICE_ACCOUNT=true）" };
  }
  if (!GDRIVE_FOLDER_ID) {
    return { ok: false, error: "未設定 GDRIVE_FOLDER_ID（Shared Drive 裡的目標資料夾 ID）" };
  }

  const drv = getDrive();

  try {
    const { stageFolderId } = await ensureProjectStageFolder(
      drv, GDRIVE_FOLDER_ID, projectNo, projectName, stageNo, stageName
    );

    // 命名：工程編號_階段編號_台北時間_原檔名
    const stamp = taipeiTimestamp();
    const baseOriginal = path.basename(originalName || "file");
    const fileName = `${projectNo}_${stageNo}_${stamp}_${safeSegment(baseOriginal)}`;

    const media = { mimeType: mimeType || "application/octet-stream", body: Readable.from(buffer) };

    const { data: created } = await drv.files.create({
      requestBody: {
        name: fileName,
        parents: [stageFolderId],
        // 加上 appProperties 以便之後從 Drive API 也能追溯（可選）
        appProperties: appProps || undefined,
        description: appProps?.uploadedByName
          ? `Uploaded by ${appProps.uploadedByName} at ${new Date().toISOString()}`
          : undefined,
      },
      media,
      fields: "id,name,parents,webViewLink,webContentLink,thumbnailLink,iconLink",
      supportsAllDrives: true,
    });

    /* 🔐 檔案權限：預設不公開（Production 安全）
       - DEV 想方便預覽：.env 設 DRIVE_PUBLIC_READ=true
       - PROD 建議不要設（維持非公開，由 Shared Drive 權限控管）
    */
    try {
      if (DRIVE_PUBLIC_READ) { // [DEV ONLY]
        await drv.permissions.create({
          fileId: created.id,
          requestBody: { role: "reader", type: "anyone" },
          supportsAllDrives: true,
        });
      }
    } catch (_) {
      // 權限設定失敗不致命，忽略
    }

    // 取回完整資訊
    const { data: info } = await drv.files.get({
      fileId: created.id,
      fields: "id,name,webViewLink,webContentLink,thumbnailLink,iconLink",
      supportsAllDrives: true,
    });

    return {
      ok: true,
      fileId: info.id,
      driveFileName: info.name,
      stageFolderId,
      webViewLink: info.webViewLink || null,
      webContentLink: info.webContentLink || null,
      thumbnailLink: info.thumbnailLink || null,
      iconLink: info.iconLink || null,
    };
  } catch (err) {
    const e = err?.errors?.[0] || err?.response?.data?.error || err;
    const detail = typeof e === "string" ? e : e?.message || e?.statusText || JSON.stringify(e);
    const code = e?.code || err?.code || err?.response?.status;
    return { ok: false, error: `DriveError${code ? `(${code})` : ""}: ${detail}` };
  }
}

/* ================== 解析專案/階段（保留原邏輯） ================== */
async function resolveUploadTargetDir(req, _res, next) {
  try {
    const projectNo = String(req.params.projectNo || "");
    const stageNoInt = Number(req.params.stageNo);

    // 建立對應本地目錄（相容性；實際已 memoryStorage）
    try { fs.mkdirSync(UPLOAD_ROOT, { recursive: true }); fs.accessSync(UPLOAD_ROOT, fs.constants.W_OK); } catch {}

    const { rows } = await pool.query(
      `SELECT name FROM project WHERE project_id = $1 LIMIT 1`,
      [projectNo]
    );
    const projectName = rows.length ? rows[0].name : "未命名專案";
    const stageName = getStageName(stageNoInt);

    const outerDir = `${projectNo}_${safeSegment(projectName)}`;
    const innerDir = `${stageNoInt}_${safeSegment(stageName)}`;
    const targetDir = path.join(UPLOAD_ROOT, outerDir, innerDir);
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}

    req._targetDir = targetDir;
    req._projectName = projectName;
    req._stageName = stageName;

    next();
  } catch (err) {
    if (DEV_DEBUG) console.error("[upload] resolveUploadTargetDir error:", err);
    next(err);
  }
}

/* ================== Multer（memoryStorage） ================== */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const m = (file.mimetype || "").toLowerCase();
    if (!ALLOWED_MIME.includes(m)) return cb(new Error("不允許的檔案格式"));
    cb(null, true);
  },
});
const acceptAny = upload.any();

/* ================== Router ================== */
const router = express.Router();

/**
 * 上傳：/projects/:projectNo/stages/:stageNo/upload
 * - 需登入（attachUser + requireAuth）
 * - 會從 req.user.username 反查 user.name，存到 uploaded_by_name
 */
router.post(
  "/projects/:projectNo/stages/:stageNo/upload",
  attachUser,
  requireAuth,
  resolveUploadTargetDir,
  acceptAny,
  async (req, res) => {
    const client = await pool.connect();
    try {
      // [PROD KEEP] 目前只允許 Service Account 模式
      if (!DRIVE_USE_SERVICE_ACCOUNT) {
        return res.status(400).json({ ok: false, error: "Service Account 模式未啟用（DRIVE_USE_SERVICE_ACCOUNT=true）" });
      }

      const projectNo = String(req.params.projectNo || "");
      const stageNo = Number(req.params.stageNo);

      if (!projectNo || !Number.isFinite(stageNo) || stageNo <= 0) {
        return res.status(400).json({ ok: false, error: "參數錯誤" });
      }
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ ok: false, error: "沒有檔案" });
      }

      // 1) 依 user_name 反查真實姓名 name（你 DB 的欄位我猜是 user.username / user.name）
      let uploadedByName = null;
      const loginUsername = req.user?.username || req.user?.user_name || null;

      if (loginUsername) {
        try {
          // 表名/欄位名請依你的實際 schema 調整（這裡假設 user 表：username/name）
          const rs = await pool.query(
            `SELECT name FROM "user" WHERE username = $1 LIMIT 1`,
            [String(loginUsername)]
          );
          uploadedByName = rs.rows?.[0]?.name || null;
        } catch (e) {
          if (DEV_DEBUG) console.warn("[upload] 查 name 失敗，將 fallback：", e?.message || e);
        }
      }
      if (!uploadedByName) {
        // fallback：若 DB 查不到，就用 token 裡的 name 或 username
        uploadedByName = req.user?.name || req.user?.username || "unknown";
      }

      const projectName = req._projectName;
      const stageName = req._stageName;

      const savedFiles = [];
      const cloudResults = [];

      await client.query("BEGIN");

      for (const f of req.files) {
        // 附帶 appProperties（非必須，但利於從 Drive 端追溯）
        const appProps = {
          uploadedByName: String(uploadedByName || ""),
          uploadedAt: new Date().toISOString(),
          projectNo: String(projectNo),
          stageNo: String(stageNo),
        };

        // === 實際上傳到 Drive（Service Account） ===
        const r = await uploadBufferToDrive(
          f.buffer,
          f.originalname,
          f.mimetype,
          projectNo,
          stageNo,
          projectName,
          stageName,
          appProps
        );
        if (!r.ok) throw new Error(r.error || "Drive upload failed");

        const driveUrl = r.webViewLink || r.webContentLink;
        const driveFileId = r.fileId;
        const thumbnailLink = r.thumbnailLink || null;

        // 2) 寫入 DB：新增 uploaded_by_name
        await upsertProjectTextUpload(client, {
          project_id: projectNo,
          text_no: stageNo,
          file_url: driveUrl,
          drive_file_id: driveFileId,
          thumbnail_link: thumbnailLink,
          uploaded_by_name: uploadedByName, // ← ★ 請在 repo 的 INSERT/UPSERT 補上這個欄位 ★
        });

        // 回傳用
        savedFiles.push({
          url: driveUrl,
          name: r.driveFileName,          // 雲端實際檔名
          originalName: f.originalname,   // 原檔名（稽核用）
          size: f.size,
          mime: f.mimetype,
        });
        cloudResults.push({ drive: { ok: true, url: driveUrl, fileId: driveFileId, thumbnailLink } });
      }

      await client.query("COMMIT");
      return res.json({
        ok: true,
        files: savedFiles,
        cloud: cloudResults,
        cloudTarget: CLOUD_TARGET,
      });
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch {}
      console.error("[stage upload] error:", err);
      return res.status(500).json({
        ok: false,
        error: DEV_DEBUG ? `SERVER_ERROR: ${err?.message || err}` : "上傳失敗",
      });
    } finally {
      client.release();
    }
  }
);

/**
 * 查詢：最後一次上傳（保留原介面）
 */
router.get(
  "/projects/:projectNo/stages/:stageNo/last",
  requireAuth,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { projectNo, stageNo } = req.params;
      const row = await getLastUpload(client, {
        project_id: String(projectNo),
        text_no: Number(stageNo),
      });
      return res.json({ ok: true, file: row || null });
    } catch (err) {
      console.error("get last upload failed:", err);
      return res.status(500).json({ ok: false, error: err.message });
    } finally {
      client.release();
    }
  }
);

/* ================== 健康檢查（Service Account 版） ================== */
(async function bootCheck() {
  try {
    if (!DRIVE_USE_SERVICE_ACCOUNT) {
      console.log("[Drive] Service Account 模式未啟用（DRIVE_USE_SERVICE_ACCOUNT=false）");
      return;
    }
    if (!GDRIVE_FOLDER_ID) {
      console.warn("[Drive] 未設定 GDRIVE_FOLDER_ID（上傳目標資料夾 ID）。");
    }
    // 試拉一次 token（Metadata Server）
    const d = getDrive();
    // 若有設定 Shared Drive ID，可快速驗證可讀
    if (DRIVE_SHARED_DRIVE_ID) {
      try {
        await d.files.list({
          pageSize: 1,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          driveId: DRIVE_SHARED_DRIVE_ID,
          corpora: "drive",
          fields: "files(id,name)",
        });
        if (DEV_DEBUG) {
          console.log("[Drive] Service Account 驗證成功，可讀 Shared Drive：", DRIVE_SHARED_DRIVE_ID);
        }
      } catch (e) {
        console.warn("[Drive] Shared Drive 檢查失敗：", e?.response?.data?.error?.message || e.message || String(e));
      }
    } else {
      if (DEV_DEBUG) console.log("[Drive] 未提供 DRIVE_SHARED_DRIVE_ID（僅影響查詢精準度，上傳不受影響）");
    }
  } catch (e) {
    console.warn("[Drive] boot check error:", e?.message || String(e));
  }
})();

/* ================== 診斷端點（建議 DEV 開、PROD 關或限 Admin） ================== */
// 方案 1：只在 DEV 開（PROD 完全不提供）
if (!IS_PROD) {
  router.get("/__drive/diag", async (req, res) => {
    try {
      if (!process.env.DRIVE_USE_SERVICE_ACCOUNT) {
        return res.status(400).json({ ok: false, msg: "DRIVE_USE_SERVICE_ACCOUNT 未設" });
      }
      if (!process.env.GDRIVE_FOLDER_ID) {
        return res.status(400).json({ ok: false, msg: "GDRIVE_FOLDER_ID 未設" });
      }
      const d = getDrive();
      const meta = await d.files.get({
        fileId: process.env.GDRIVE_FOLDER_ID,
        fields: "id,name,mimeType,driveId",
        supportsAllDrives: true,
      });
      const list = await d.files.list({
        q: `'${process.env.GDRIVE_FOLDER_ID}' in parents and trashed=false`,
        fields: "files(id,name)",
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        ...(process.env.DRIVE_SHARED_DRIVE_ID ? { driveId: process.env.DRIVE_SHARED_DRIVE_ID, corpora: "drive" } : {}),
      });
      res.json({ ok: true, folder: meta.data, sample: list.data.files });
    } catch (e) {
      const msg = e?.response?.data?.error?.message || e?.message || String(e);
      res.status(500).json({ ok: false, error: msg });
    }
  });
}

/* 方案 2：如果你要在 PROD 也保留這個端點，務必限管理員（請二選一，預設註解掉） */
// router.get("/__drive/diag", requireAdmin, async (req, res) => {
//   try {
//     if (!process.env.DRIVE_USE_SERVICE_ACCOUNT) {
//       return res.status(400).json({ ok: false, msg: "DRIVE_USE_SERVICE_ACCOUNT 未設" });
//     }
//     if (!process.env.GDRIVE_FOLDER_ID) {
//       return res.status(400).json({ ok: false, msg: "GDRIVE_FOLDER_ID 未設" });
//     }
//     const d = getDrive();
//     const meta = await d.files.get({
//       fileId: process.env.GDRIVE_FOLDER_ID,
//       fields: "id,name,mimeType,driveId",
//       supportsAllDrives: true,
//     });
//     const list = await d.files.list({
//       q: `'${process.env.GDRIVE_FOLDER_ID}' in parents and trashed=false`,
//       fields: "files(id,name)",
//       pageSize: 1,
//       supportsAllDrives: true,
//       includeItemsFromAllDrives: true,
//       ...(process.env.DRIVE_SHARED_DRIVE_ID ? { driveId: process.env.DRIVE_SHARED_DRIVE_ID, corpora: "drive" } : {}),
//     });
//     res.json({ ok: true, folder: meta.data, sample: list.data.files });
//   } catch (e) {
//     const msg = e?.response?.data?.error?.message || e?.message || String(e);
//     res.status(500).json({ ok: false, error: msg });
//   }
// });

/* ============================================================
 *  OAuth Public Router（本機用 OAuth）
 *  ------------------------------------------------------------
 *  ✔ DEV 本機使用：/api/drive/oauth2/start
 *  ✔ DEV 本機回調：/api/drive/oauth2/callback
 *  ✔ 這些路由正式環境（prod）建議關閉
 * ============================================================ */

const publicRouter = express.Router();

/**
 * OAuth Start（你以前用的）
 * GET /api/drive/oauth2/start
 */
publicRouter.get("/oauth2/start", (req, res) => {
  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      process.env.GOOGLE_OAUTH_REDIRECT
    );

    const authorizeUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/drive.file"],
      prompt: "consent",
    });

    return res.redirect(authorizeUrl);
  } catch (err) {
    console.error("[OAuth/start] error:", err);
    res.status(500).send("OAuth 初始化錯誤");
  }
});

/**
 * OAuth Callback
 * GET /api/drive/oauth2/callback
 * DEV 模式：把 token 存到 .tmp/oauth-token.json
 */
publicRouter.get("/oauth2/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("缺少 code");

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      process.env.GOOGLE_OAUTH_REDIRECT
    );

    const { tokens } = await oauth2Client.getToken(code);

    fs.mkdirSync(".tmp", { recursive: true });
    fs.writeFileSync(
      process.env.OAUTH_TOKEN_PATH || ".tmp/oauth-token.json",
      JSON.stringify(tokens, null, 2)
    );

    return res.send(`
      OAuth 授權成功！<br>
      token 已儲存：<b>${process.env.OAUTH_TOKEN_PATH || ".tmp/oauth-token.json"}</b>
    `);
  } catch (err) {
    console.error("[OAuth/callback] error:", err);
    return res.status(500).send("OAuth callback 錯誤");
  }
});

/* ============================================================
 * ⭐ IMPORTANT ⭐
 * Export public router as part of module.exports
 * ============================================================ */
module.exports = { router, publicRouter };

/* ================== 匯出 ================== */
// module.exports = { router };
