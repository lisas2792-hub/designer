// routes/stageupload.js
"use strict";

/**
 * 上線前可刪的說明：
 * - 帶 [VALIDATION] 註解的 console.log / 除錯端點，都是為了快速定位問題
 * - 可以把 DEV_DEBUG=false（或直接移除這些段落），不影響核心功能
 */

/**
 * 上傳功能（Cloud Run 版本）
 * - ✅ 使用 Multer memoryStorage：不寫磁碟，直接以 buffer 上傳到 Google Drive
 * - ✅ OAuth token 儲存在 /tmp（可寫目錄），支援 OAUTH_TOKEN_PATH 覆寫
 * - ✅ 支援共用雲端硬碟（supportsAllDrives: true）
 * - ✅ 只允許常見圖片與 PDF（可用環境變數調整）
 * - ❗ 需先完成 OAuth 授權（/api/drive/oauth2/start → /api/drive/oauth2/callback）
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { google } = require("googleapis");
const { Readable } = require("stream");

const { pool } = require("../db");
const { attachUser, requireAuth } = require("../middleware/auth");
const { upsertProjectTextUpload, getLastUpload } = require("../repositories/stageUploadRepo");

/* ================== 環境變數與參數 ================== */
const DEV_DEBUG = (process.env.DEV_DEBUG || "false").toLowerCase() === "true";

// Cloud Run 唯一可寫為 /tmp；這裡預設建立 /tmp/uploads 以防未來擴充（目前實作不落地）
const UPLOAD_ROOT = process.env.UPLOAD_ROOT
  ? path.resolve(process.env.UPLOAD_ROOT)
  : "/tmp/uploads";

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20); // 建議 < 32（Cloud Run 單請求上限）
const ALLOWED_MIME = (process.env.ALLOWED_MIME ||
  "image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,application/pdf")
  .split(",")
  .map((s) => s.trim().toLowerCase());

const CLOUD_TARGET = (process.env.CLOUD_TARGET || "DRIVE").toUpperCase();
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID;

/* ================== stages.json 讀取（支援 UTF-8/UTF-16） ================== */
const pathExists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
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
  // UTF-16 LE
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.toString("utf16le");
  // UTF-16 BE → 轉成 LE
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i < buf.length; i += 2) { swapped[i - 2] = buf[i + 1]; swapped[i - 1] = buf[i]; }
    text = swapped.toString("utf16le");
  } else {
    text = buf.toString("utf8");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去掉 BOM
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

/* ================== 共用小工具 ================== */
function safeSegment(s) {
  return String(s || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

// 建立可寫目錄（即便現在不落地，保留以兼容未來需求）
try { fs.mkdirSync(UPLOAD_ROOT, { recursive: true }); } catch {}

// 取得台北時間：YYYYMMDD-HHMMSS
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

/* ================== Google Drive OAuth2（lazy 初始化） ================== */
let drive = null;
const SCOPES = [
  "https://www.googleapis.com/auth/drive.file", // 最小必要：上傳/管理自己建立的檔案
  "https://www.googleapis.com/auth/drive"
];

// 預設寫入 /tmp，支援以 OAUTH_TOKEN_PATH 覆寫（或兼容舊名 GOOGLE_OAUTH_TOKEN_PATH）
const OAUTH_TOKEN_PATH =
  process.env.OAUTH_TOKEN_PATH ||
  process.env.GOOGLE_OAUTH_TOKEN_PATH ||
  "/tmp/oauth-token.json";

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT
  );
}
function loadSavedToken() {
  try { return JSON.parse(fs.readFileSync(OAUTH_TOKEN_PATH, "utf8")); } catch { return null; }
}
function saveToken(tokens) {
  fs.mkdirSync(path.dirname(OAUTH_TOKEN_PATH), { recursive: true });
  fs.writeFileSync(OAUTH_TOKEN_PATH, JSON.stringify(tokens), "utf8");
}
function ensureDriveReady() {
  if (drive) return drive;
  const saved = loadSavedToken();
  if (!saved) return null;
  const oauth2 = createOAuthClient();
  oauth2.setCredentials(saved);
  drive = google.drive({ version: "v3", auth: oauth2 });
  return drive;
}

/* ================== Drive 工具 ================== */
const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const escQ = (str = "") => String(str).replace(/(['\\])/g, "\\$1");

async function driveFindFolder(drv, name, parentId) {
  const q = [
    `mimeType='${DRIVE_FOLDER_MIME}'`,
    `name='${escQ(name)}'`,
    "trashed=false",
    parentId ? `'${escQ(parentId)}' in parents` : ""
  ].filter(Boolean).join(" and ");

  const { data } = await drv.files.list({
    q,
    fields: "files(id,name,parents)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
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

// ★ 直傳：使用 buffer（不落地磁碟）
async function uploadBufferToDrive(buffer, originalName, mimeType, projectNo, stageNo, projectName, stageName) {
  const drv = ensureDriveReady();
  if (!drv || !GDRIVE_FOLDER_ID) return { ok: false, error: "Drive 未設定或未授權" };

  try {
    const { stageFolderId } = await ensureProjectStageFolder(
      drv, GDRIVE_FOLDER_ID, projectNo, projectName, stageNo, stageName
    );

    // 命名：工程編號_階段編號_台北時間_原檔名尾巴（安全化）
    const stamp = taipeiTimestamp();
    const baseOriginal = path.basename(originalName || "file");
    const fileName = `${projectNo}_${stageNo}_${stamp}_${safeSegment(baseOriginal)}`;

    const media = {
      mimeType: mimeType || "application/octet-stream",
      body: Readable.from(buffer),
    };

    // 建檔
    const createRes = await drv.files.create({
      requestBody: { name: fileName, parents: [stageFolderId] },
      media,
      fields: "id,name,parents,webViewLink,webContentLink",
      supportsAllDrives: true,
    });
    const fileId = createRes.data.id;

    // （可選）開啟公開讀取權限，供前端預覽
    try {
      await drv.permissions.create({
        fileId,
        requestBody: { role: "reader", type: "anyone" },
        supportsAllDrives: true,
      });
    } catch (_) {}

    // 取最終連結/縮圖
    const info = await drv.files.get({
      fileId,
      fields: "id,webViewLink,webContentLink,thumbnailLink",
      supportsAllDrives: true,
    });

    // 回傳給呼叫端使用（含最終檔名）
    return {
      ok: true,
      fileId,
      stageFolderId,
      webViewLink: info.data.webViewLink || null,
      webContentLink: info.data.webContentLink || null,
      thumbnailLink: info.data.thumbnailLink || null,
      driveFileName: createRes.data.name, // ← 雲端實際檔名
    };
  } catch (err) {
    const e = err?.errors?.[0] || err?.response?.data?.error || err;
    const detail = typeof e === "string" ? e : e?.message || e?.statusText || JSON.stringify(e);
    const code = e?.code || err?.code || err?.response?.status;
    return { ok: false, error: `DriveError${code ? `(${code})` : ""}: ${detail}` };
  }
}

/* ================== 前置 middleware：解析專案/階段資訊 ================== */
async function resolveUploadTargetDir(req, _res, next) {
  try {
    const projectNo = String(req.params.projectNo || "");
    const stageNoInt = Number(req.params.stageNo);

    if (DEV_DEBUG) {
      console.log("[upload] params:", { projectNo, stageNoInt });
      console.log("[upload] UPLOAD_ROOT:", UPLOAD_ROOT);
    }

    // 雖然不落地，仍建立 /tmp/uploads 結構，避免未來改動需要
    try {
      fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
      fs.accessSync(UPLOAD_ROOT, fs.constants.W_OK);
    } catch {}

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

/* ================== Multer（memoryStorage，不落地） ================== */
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

/* ================== Router 初始化 ================== */
const publicRouter = express.Router(); // 不需登入（OAuth/檢查）
const router = express.Router();       // 需登入（上傳/查詢）

/* ============ 公開：OAuth 流程（一次授權即可） ============ */
publicRouter.get("/oauth2/start", (_req, res) => {
  const oauth2 = createOAuthClient();
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    include_granted_scopes: true,
  });
  res.redirect(url);
});

publicRouter.get("/oauth2/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const oauth2 = createOAuthClient();
    const { tokens } = await oauth2.getToken(code);
    saveToken(tokens);
    oauth2.setCredentials(tokens);
    drive = google.drive({ version: "v3", auth: oauth2 });
    res.send("Google Drive 授權完成，請回到系統再試上傳。");
  } catch (e) {
    console.error("[OAuth callback] error:", e?.response?.data || e);
    res.status(500).send("授權失敗：" + (e?.message || e));
  }
});

/* ============ 公開：Drive 狀態檢查（實用） ============ */
// 驗證目前 OAuth 身分
publicRouter.get("/__whoami", async (_req, res) => {
  try {
    const drv = ensureDriveReady();
    if (!drv) return res.json({ ok: false, message: "Drive client not ready (未授權或無 token)" });
    const me = await drv.about.get({ fields: "user, storageQuota" });
    res.json({ ok: true, user: me.data.user, storageQuota: me.data.storageQuota });
  } catch (e) {
    const msg = e?.response?.data?.error?.message || e.message || String(e);
    if (/invalid_grant/i.test(msg)) {
      return res.status(401).json({ ok:false, error:"INVALID_GRANT", hint:"請重新授權：/api/drive/oauth2/start" });
    }
    res.json({ ok: false, error: msg });
  }
});

// 檢查目標資料夾是否可讀/為資料夾
publicRouter.get("/__check-folder", async (_req, res) => {
  try {
    const drv = ensureDriveReady();
    if (!drv) return res.json({ ok: false, msg: "Drive client not ready (未授權)" });
    const meta = await drv.files.get({
      fileId: GDRIVE_FOLDER_ID,
      fields: "id,name,mimeType,driveId,permissions",
      supportsAllDrives: true,
    });
    res.json({ ok: true, meta: meta.data });
  } catch (e) {
    const msg = e?.response?.data?.error?.message || e.message || String(e);
    if (/invalid_grant/i.test(msg)) {
      return res.status(401).json({ ok:false, error:"INVALID_GRANT", hint:"請重新授權：/api/drive/oauth2/start" });
    }
    res.json({ ok: false, error: msg });
  }
});

/* ============ 受保護：上傳與查詢 ============ */
// 上傳：/projects/:projectNo/stages/:stageNo/upload
router.post(
  "/projects/:projectNo/stages/:stageNo/upload",
  attachUser,
  requireAuth,
  resolveUploadTargetDir,
  acceptAny,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const projectNo = String(req.params.projectNo || "");
      const stageNo = Number(req.params.stageNo);

      if (!projectNo || !Number.isFinite(stageNo) || stageNo <= 0) {
        return res.status(400).json({ ok: false, error: "參數錯誤" });
      }
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ ok: false, error: "沒有檔案" });
      }

      const projectName = req._projectName;
      const stageName = req._stageName;

      const savedFiles = [];
      const cloudResults = [];

      await client.query("BEGIN");

      for (const f of req.files) {
        const r = await uploadBufferToDrive(
          f.buffer,
          f.originalname,
          f.mimetype,
          projectNo,
          stageNo,
          projectName,
          stageName
        );
        if (!r.ok) throw new Error(r.error || "Drive upload failed");

        const driveUrl = r.webViewLink || r.webContentLink;
        const driveFileId = r.fileId;
        const thumbnailLink = r.thumbnailLink || null;

        await upsertProjectTextUpload(client, {
          project_id: projectNo,
          text_no: stageNo,
          file_url: driveUrl,
          drive_file_id: driveFileId,
          thumbnail_link: thumbnailLink,
        });

        const driveFileName = r.driveFileName; // 從 uploadBufferToDrive 回傳值取得
        savedFiles.push({
          url: driveUrl,
          name: driveFileName,           // 統一用雲端最終檔名
          originalName: f.originalname,  // 保留原始檔名供查核
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

// 查詢：最後一次上傳
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

/* ================== 啟動時簡易檢查（可留作健康檢查） ================== */
(async function bootLogDriveOnce() {
  try {
    const drv = ensureDriveReady();
    if (!drv) {
      console.log("[Drive] client not ready (no token or missing OAuth).");
      console.log("        → 請先走 /api/drive/oauth2/start 完成授權。");
      return;
    }
    console.log("[Drive] OAuth token loaded, client ready.");

    if (GDRIVE_FOLDER_ID) {
      try {
        const meta = await drv.files.get({
          fileId: GDRIVE_FOLDER_ID,
          fields: "id,name,mimeType,driveId",
          supportsAllDrives: true,
        });
        if (meta?.data?.mimeType === "application/vnd.google-apps.folder") {
          console.log("[Drive] Root folder OK:", { id: meta.data.id, name: meta.data.name });
        } else {
          console.warn("[Drive] 指定的 GDRIVE_FOLDER_ID 不是資料夾或不可讀。");
        }
      } catch (e) {
        console.warn("[Drive] Root folder check failed:", e?.response?.data?.error?.message || e.message || String(e));
      }
    } else {
      console.log("[Drive] GDRIVE_FOLDER_ID 未設定（略過根資料夾檢查）。");
    }
  } catch (e) {
    console.warn("[Drive] boot check error:", e?.message || String(e));
  }
})();

/* ================== 匯出：公開 & 受保護 Router ================== */
module.exports = { router, publicRouter };
