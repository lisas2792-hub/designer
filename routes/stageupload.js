// routes/stageupload.js
"use strict";

/**
 * 上線前可刪的說明：
 * - 帶 [VALIDATION] 註解的 console.log / 除錯端點，都是為了快速定位問題
 * - 你可以把 DEV_DEBUG=false（或直接移除這些段落），不影響核心功能
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const dayjs = require("dayjs");
const multer = require("multer");
const mime = require("mime-types");
const { google } = require("googleapis");

const { pool } = require("../db");
const { attachUser, requireAuth } = require("../middleware/auth");

// ★ 抽離 SQL：repositories
const {
  upsertProjectTextUpload,
  getLastUpload,
} = require("../repositories/stageUploadRepo");

/* ================== 環境變數與參數 ================== */
const DEV_DEBUG = (process.env.DEV_DEBUG || "false").toLowerCase() === "true";

const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_ROOT || "public/uploads");
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 50);
const ALLOWED_MIME = (process.env.ALLOWED_MIME ||
  "image/jpeg,image/png,image/webp,image/gif,application/pdf")
  .split(",")
  .map((s) => s.trim().toLowerCase());

const CLOUD_TARGET = (process.env.CLOUD_TARGET || "DRIVE").toUpperCase();
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID;

/* ================== stages.json 讀取（支援 UTF-8/UTF-16；自動尋找路徑） ================== */
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

function normalizeDigitKey(k) {
  return String(k).replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 0x30)
  );
}

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

    if (DEV_DEBUG) {
      console.log("[stages] using file:", STAGES_JSON);
      // console.log("[stages] keys:", Object.keys(STAGE_MAP));
      // console.log("[stages] #1 =", STAGE_MAP[1] ?? STAGE_MAP["1"]);
    }
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

/* ================== 通用工具 ================== */
function safeSegment(s) {
  return String(s || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

/* ================== Google Drive OAuth2（lazy 初始化） ================== */
let drive = null;
const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive",
];
const OAUTH_TOKEN_PATH =
  process.env.GOOGLE_OAUTH_TOKEN_PATH || path.resolve("oauth-token.json");

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
function escQ(str = "") { return String(str).replace(/(['\\])/g, "\\$1"); }

async function driveFindFolder(drv, name, parentId) {
  // FIX: 這裡以前反引號放錯，或沒觸發樣板字串 → 導致語法錯或查詢失敗
  const q = [
    `mimeType='${DRIVE_FOLDER_MIME}'`,
    `name='${escQ(name)}'`,
    "trashed=false",
    parentId ? `'${escQ(parentId)}' in parents` : "" // ← 用單引號包住 id，整段用樣板字串組好
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

async function uploadToDrive(absPath, projectNo, stageNo, projectName, stageName) {
  const drv = ensureDriveReady();
  if (!drv || !GDRIVE_FOLDER_ID) return { ok: false, error: "Drive 未設定或未授權" };
  try {
    const { stageFolderId } = await ensureProjectStageFolder(
      drv, GDRIVE_FOLDER_ID, projectNo, projectName, stageNo, stageName
    );

    const fileName = path.basename(absPath);
    const createRes = await drv.files.create({
      resource: { name: `${projectNo}_${stageNo}_${fileName}`, parents: [stageFolderId] },
      media: { mimeType: mime.lookup(absPath) || "application/octet-stream", body: fs.createReadStream(absPath) },
      fields: "id,name,parents,driveId,webViewLink,webContentLink",
      supportsAllDrives: true,
    });

    const fileId = createRes.data.id;

    try {
      await drv.permissions.create({
        fileId, resource: { role: "reader", type: "anyone" }, supportsAllDrives: true,
      });
    } catch (_) {}

    const info = await drv.files.get({
      fileId, fields: "id,parents,driveId,webViewLink,webContentLink,thumbnailLink",
      supportsAllDrives: true,
    });

    return {
      ok: true,
      fileId,
      stageFolderId,
      webViewLink: info.data.webViewLink || null,
      webContentLink: info.data.webContentLink || null,
      thumbnailLink: info.data.thumbnailLink || null,
    };
  } catch (err) {
    const e = err?.errors?.[0] || err?.response?.data?.error || err;
    const detail = typeof e === "string" ? e : e?.message || e?.statusText || JSON.stringify(e);
    const code = e?.code || err?.code || err?.response?.status;
    return { ok: false, error: `DriveError${code ? `(${code})` : ""}: ${detail}` };
  }
}

/* ================== 解析目標目錄（前置 middleware） ================== */
async function resolveUploadTargetDir(req, _res, next) {
  try {
    const projectNo = String(req.params.projectNo || "");
    const stageNoInt = Number(req.params.stageNo);

    if (DEV_DEBUG) {
      console.log("[upload] params:", { projectNo, stageNoInt });
      console.log("[upload] UPLOAD_ROOT:", UPLOAD_ROOT);
    }

    fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
    fs.accessSync(UPLOAD_ROOT, fs.constants.W_OK);

    const { rows } = await pool.query(
      `SELECT name FROM project WHERE project_id = $1 LIMIT 1`,
      [projectNo]
    );
    const projectName = rows.length ? rows[0].name : "未命名專案";
    const stageName = getStageName(stageNoInt);

    const outerDir = `${projectNo}_${safeSegment(projectName)}`;
    const innerDir = `${stageNoInt}_${safeSegment(stageName)}`;
    const targetDir = path.join(UPLOAD_ROOT, outerDir, innerDir);
    fs.mkdirSync(targetDir, { recursive: true });

    req._targetDir = targetDir;
    req._projectName = projectName;
    req._stageName = stageName;

    if (DEV_DEBUG) {
      console.log("[upload] stage resolved ->", {
        stageNoInt,
        stageName,
        sample1: STAGE_MAP[1] ?? STAGE_MAP["1"],
      });
    }

    next();
  } catch (err) {
    if (DEV_DEBUG) console.error("[upload] resolveUploadTargetDir error:", err);
    next(err);
  }
}

/* ================== Multer（本地暫存） ================== */
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const dir = req._targetDir || UPLOAD_ROOT;
    if (DEV_DEBUG) console.log("[upload] multer.destination ->", dir);
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const base = path.basename(file.originalname || "file", ext).replace(/[^\w.\-]/g, "_");
    const ts = dayjs().format("YYYYMMDD_HHmmss_SSS");
    cb(null, `${ts}_${base}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const m = (file.mimetype || "").toLowerCase();
    if (!ALLOWED_MIME.includes(m)) return cb(new Error("不允許的檔案格式"));
    cb(null, true);
  },
});
const acceptAny = upload.any();

/* ================== Router 初始化 ================== */
const publicRouter = express.Router(); // 不需登入
const router = express.Router();       // 需登入

/* ============ 公開：OAuth 流程 ============ */
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

// [VALIDATION] 一鍵重設 OAuth token（壞掉時用，上線可刪）
publicRouter.post("/oauth2/reset", (_req, res) => {
  try {
    if (fs.existsSync(OAUTH_TOKEN_PATH)) fs.unlinkSync(OAUTH_TOKEN_PATH);
    drive = null;
    res.json({ ok: true, msg: "已刪除 token 檔，請重新走 /api/drive/oauth2/start 授權" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

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
      return res.status(401).json({ ok:false, error:"INVALID_GRANT", hint:"請 POST /api/drive/oauth2/reset 後再走 /api/drive/oauth2/start" });
    }
    res.json({ ok: false, error: msg });
  }
});

// ✅ 檢查目標資料夾（成功時會印出你想要的 log）
publicRouter.get("/__check-folder", async (_req, res) => {
  try {
    const drv = ensureDriveReady();
    if (!drv) return res.json({ ok: false, msg: "Drive client not ready (未授權)" });
    const meta = await drv.files.get({
      fileId: GDRIVE_FOLDER_ID,
      fields: "id,name,mimeType,driveId,permissions",
      supportsAllDrives: true,
    });

    if (meta?.data?.mimeType === "application/vnd.google-apps.folder") {
      console.log("[Drive] Root folder OK:", {
        id: meta.data.id,
        name: meta.data.name,
        driveId: meta.data.driveId,
      });
    }

    res.json({ ok: true, meta: meta.data });
  } catch (e) {
    const msg = e?.response?.data?.error?.message || e.message || String(e);
    if (/invalid_grant/i.test(msg)) {
      return res.status(401).json({ ok:false, error:"INVALID_GRANT", hint:"請 POST /api/drive/oauth2/reset 後再走 /api/drive/oauth2/start" });
    }
    res.json({ ok: false, error: msg });
  }
});

/* ---------- [VALIDATION] 深度除錯：檢查 stages 檔案與內容片段 ---------- */
publicRouter.get("/__stages_debug", (_req, res) => {
  try {
    const stat = pathExists(STAGES_JSON) ? fs.statSync(STAGES_JSON) : null;
    const buf = pathExists(STAGES_JSON) ? fs.readFileSync(STAGES_JSON) : Buffer.alloc(0);
    const headHex = buf.length ? Array.from(buf.slice(0, 64)).map(b => b.toString(16).padStart(2, "0")).join(" ") : "(no file)";
    let previewDecoded = "";
    try {
      if (pathExists(STAGES_JSON)) {
        const decoded = decodeJsonFileSmart(STAGES_JSON);
        previewDecoded = JSON.stringify(decoded).slice(0, 200);
      } else {
        previewDecoded = "(no file)";
      }
    } catch (e) {
      previewDecoded = `decode error: ${e?.message || e}`;
    }
    res.json({
      using: STAGES_JSON,
      size: stat?.size ?? 0,
      mtime: stat?.mtime ?? null,
      headHex,
      previewDecoded,
      currentMapKeys: Object.keys(STAGE_MAP),
      sample: { "1": STAGE_MAP[1] ?? STAGE_MAP["1"] },
    });
  } catch (e) {
    res.json({ error: e?.message || String(e), using: STAGES_JSON });
  }
});

/* ---------- [VALIDATION] Stages 檢視/熱重載 ---------- */
publicRouter.get("/__stages", (_req, res) => {
  const existsList = (STAGES_JSON_INFO.candidates || []).map(fp => ({
    path: fp, exists: pathExists(fp)
  }));
  res.json({
    using: STAGES_JSON,
    candidates: existsList,
    keys: Object.keys(STAGE_MAP),
    sample: { "1": STAGE_MAP[1] ?? STAGE_MAP["1"] },
    map: STAGE_MAP,
  });
});

publicRouter.post("/__reload-stages", (_req, res) => {
  STAGES_JSON_INFO = findStagesJson();
  STAGES_JSON = STAGES_JSON_INFO.file;
  loadStages();
  const existsList = (STAGES_JSON_INFO.candidates || []).map(fp => ({
    path: fp, exists: pathExists(fp)
  }));
  res.json({
    ok: true,
    using: STAGES_JSON,
    candidates: existsList,
    keys: Object.keys(STAGE_MAP),
    sample: { "1": STAGE_MAP[1] ?? STAGE_MAP["1"] },
  });
});
/* ---------- [/VALIDATION] ---------- */

/* ============ 受保護：上傳與查詢 ============ */
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

      const savedLocal = [];
      const savedCloud = [];

      await client.query("BEGIN");

      for (const f of req.files) {
        const r = await uploadToDrive(f.path, projectNo, stageNo, projectName, stageName);
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

        savedLocal.push({ url: driveUrl, name: f.originalname, size: f.size, mime: f.mimetype });
        savedCloud.push({ drive: { ok: true, url: driveUrl, fileId: driveFileId, thumbnailLink } });
      }

      await client.query("COMMIT");
      return res.json({
        ok: true,
        files: savedLocal,
        cloud: savedCloud,
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

// 目錄除錯（可刪）
router.get(
  "/projects/:projectNo/stages/:stageNo/__debug-target",
  attachUser,
  requireAuth,
  resolveUploadTargetDir,
  (req, res) => {
    return res.json({ ok: true, uploadRoot: UPLOAD_ROOT, targetDir: req._targetDir });
  }
);

// 查最後一次上傳的檔案
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

/* ============================================================
   ★★★ ADDED: 啟動即印 Drive 狀態（你想看的兩行）
============================================================ */
(async function bootLogDriveOnce() {
  try {
    const drv = ensureDriveReady();
    if (!drv) {
      console.log("[Drive] client not ready (no token or missing OAuth).");
      console.log("        → 若剛安裝，請先走 /api/drive/oauth2/start 完成授權。");
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
          console.log("[Drive] Root folder OK:", {
            id: meta.data.id,
            name: meta.data.name,
            driveId: meta.data.driveId,
          });
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
