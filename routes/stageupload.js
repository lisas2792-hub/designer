"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const dayjs = require("dayjs");
const multer = require("multer");
const mime = require("mime-types");
const { pool } = require("../db");
const { attachUser, requireAuth } = require("../middleware/auth");
const { google } = require("googleapis");                // ★ ADDED: 使用 OAuth2

// ★ ADDED: 兩個 Router（公開 OAuth & 受保護 API）
const publicRouter = express.Router();
const router = express.Router();

// ★（可選）本地除錯開關
const DEV_DEBUG = (process.env.DEV_DEBUG || "false").toLowerCase() === "true";

/* ================= 對照表：階段名稱 ================= */
const STAGE_NAMES = {
  1: "丈量",
  2: "案例分析",
  3: "平面放樣",
  4: "平面圖",
  5: "平面系統圖",
  6: "立面框體圖",
  7: "立面圖",
  8: "施工圖",
};

/* ================= 路徑與環境 ================= */
const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_ROOT || "public/uploads");
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20);
const ALLOWED_MIME = (process.env.ALLOWED_MIME ||
  "image/jpeg,image/png,image/webp,image/gif,application/pdf")
  .split(",")
  .map((s) => s.trim().toLowerCase());

const CLOUD_TARGET = (process.env.CLOUD_TARGET || "NONE").toUpperCase();
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID;

// 確保根目錄存在
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

/* ================= 工具 ================= */
function toPublicUrl(absPath) {
  const rel = path.relative(UPLOAD_ROOT, absPath).replace(/\\/g, "/");
  return `/uploads/${rel}`;
}

function safeSegment(s) {
  return String(s || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

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
    const stageName = STAGE_NAMES[stageNoInt] || `stage_${stageNoInt}`;

    const outerDir = `${projectNo}_${safeSegment(projectName)}`;
    const innerDir = `${stageNoInt}_${safeSegment(stageName)}`;
    const targetDir = path.join(UPLOAD_ROOT, outerDir, innerDir);

    fs.mkdirSync(targetDir, { recursive: true });
    req._targetDir = targetDir;
    next();
  } catch (err) {
    if (DEV_DEBUG) console.error("[upload] resolveUploadTargetDir error:", err);
    next(err);
  }
}

/* ================= Multer（磁碟存檔） ================= */
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const dir = req._targetDir || UPLOAD_ROOT;
    if (DEV_DEBUG) console.log("[upload] multer.destination ->", dir);
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const base = path.basename(file.originalname || "file", ext).replace(/[^\w.\-]+/g, "_");
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

/* ================= Google Drive（OAuth2） ================= */
// ★ REMOVED: 舊的 GoogleAuth / Service Account 邏輯
// ★ ADDED: OAuth 流程 + 單一全域 drive client
let drive = null;

const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive",
];

const OAUTH_TOKEN_PATH =
  process.env.GOOGLE_OAUTH_TOKEN_PATH || path.resolve("oauth-token.json");

function loadSavedToken() {
  try { return JSON.parse(fs.readFileSync(OAUTH_TOKEN_PATH, "utf8")); } catch { return null; }
}
function saveToken(tokens) {
  fs.mkdirSync(path.dirname(OAUTH_TOKEN_PATH), { recursive: true });
  fs.writeFileSync(OAUTH_TOKEN_PATH, JSON.stringify(tokens), "utf8");
}
function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT
  );
}

// 啟動時載入 token（若有）
(function initDriveOAuth() {
  if (CLOUD_TARGET !== "DRIVE" && CLOUD_TARGET !== "BOTH") return;
  const saved = loadSavedToken();
  if (saved) {
    if (!saved.refresh_token) {
      console.warn("[Drive] ⚠ token 檔沒有 refresh_token；建議刪除 token 檔後重新授權 /api/drive/oauth2/start");
    }
    const oauth2 = createOAuthClient();
    oauth2.setCredentials(saved);
    drive = google.drive({ version: "v3", auth: oauth2 });
    if (DEV_DEBUG) console.log("[Drive] OAuth token loaded, client ready.");
  } else {
    console.warn("[Drive] 尚未授權，請先開 /api/drive/oauth2/start");
  }
})();

// ★ ADDED: 啟動後驗證資料夾 ID 是否可讀（可略）
(async function validateFolderIdAtBoot() {
  try {
    if (!drive || !GDRIVE_FOLDER_ID) return;
    const meta = await drive.files.get({
      fileId: GDRIVE_FOLDER_ID,
      fields: "id,name,mimeType,driveId",
      supportsAllDrives: true,
    });
    if (meta.data.mimeType !== "application/vnd.google-apps.folder") {
      console.warn("[Drive] ⚠ GDRIVE_FOLDER_ID 不是資料夾 ID。請用 /folders/<ID> 的那串。");
    } else if (DEV_DEBUG) {
      console.log("[Drive] Target folder OK:", {
        id: meta.data.id, name: meta.data.name, driveId: meta.data.driveId
      });
    }
  } catch (e) {
    console.warn("[Drive] ⚠ 無法驗證 GDRIVE_FOLDER_ID：", e?.response?.data?.error?.message || e.message || e);
  }
})();

/* ============ 公開：OAuth 路由（掛在 publicRouter；不需登入驗證） ============ */
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

// 驗證目前 OAuth 身分
publicRouter.get("/__whoami", async (_req, res) => {
  try {
    if (!drive) return res.json({ ok:false, message:'Drive client not ready (未授權或無 token)' });
    const me = await drive.about.get({ fields: 'user, storageQuota' });
    res.json({ ok:true, user: me.data.user, storageQuota: me.data.storageQuota });
  } catch (e) {
    res.json({ ok:false, error: String(e?.response?.data?.error?.message || e.message || e) });
  }
});

// （可選）檢查資料夾可存取
publicRouter.get("/__check-folder", async (_req, res) => {
  try {
    if (!drive) return res.json({ ok:false, msg:"Drive client not ready (未授權)" });
    const meta = await drive.files.get({
      fileId: GDRIVE_FOLDER_ID,
      fields: "id,name,mimeType,driveId,permissions",
      supportsAllDrives: true,
    });
    res.json({ ok:true, meta: meta.data });
  } catch (e) {
    res.json({ ok:false, error: e?.response?.data?.error?.message || e.message || String(e) });
  }
});

/* ============ 上傳：受保護 API（掛在 router；需登入驗證） ============ */
async function uploadToDrive(absPath, projectNo, stageNo) {
  if (!drive || !GDRIVE_FOLDER_ID) return { ok: false, error: "Drive 未設定或未授權" };
  try {
    const fileName = path.basename(absPath);
    const fileMeta = {
      name: `${projectNo}_${stageNo}_${fileName}`,
      parents: [GDRIVE_FOLDER_ID],
    };
    const media = {
      mimeType: mime.lookup(absPath) || "application/octet-stream",
      body: fs.createReadStream(absPath),
    };
    const createRes = await drive.files.create({
      resource: fileMeta,
      media,
      fields: "id,name,parents,driveId,webViewLink,webContentLink", // ★ CHANGED: 回傳更多欄位
      supportsAllDrives: true,
    });
    const fileId = createRes.data.id;

    // 嘗試設公開讀取（若組織策略不允許，失敗也不影響上傳）
    try {
      await drive.permissions.create({
        fileId,
        resource: { role: "reader", type: "anyone" },
        supportsAllDrives: true,
      });
    } catch (permErr) {
      if (DEV_DEBUG) console.warn("[Drive] set public permission failed:", permErr?.message || permErr);
    }

    const info = await drive.files.get({
      fileId,
      fields: "id,parents,driveId,webViewLink,webContentLink",
      supportsAllDrives: true,
    });

    const url = info.data.webContentLink || info.data.webViewLink;
    return { ok: true, url, fileId, parents: info.data.parents, driveId: info.data.driveId };
  } catch (err) {
    const e = err?.errors?.[0] || err?.response?.data?.error || err;
    const detail = typeof e === "string" ? e : (e.message || e.statusText || JSON.stringify(e));
    const code = e?.code || err?.code || err?.response?.status;
    return { ok: false, error: `DriveError${code ? `(${code})` : ""}: ${detail}` };
  }
}

router.post(
  "/projects/:projectNo/stages/:stageNo/upload",
  attachUser,
  requireAuth,
  resolveUploadTargetDir,
  acceptAny,
  async (req, res) => {
    try {
      const projectNo = String(req.params.projectNo || "");
      const stageNo = Number(req.params.stageNo);

      if (!projectNo || !Number.isFinite(stageNo) || stageNo <= 0) {
        return res.status(400).json({ ok: false, error: "參數錯誤" });
      }
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ ok: false, error: "沒有檔案" });
      }

      const savedLocal = [];
      const savedCloud = [];

      for (const f of req.files) {
        const localUrl = toPublicUrl(f.path);

        await pool.query(
          `INSERT INTO project_text_upload (project_id, text_no, file_url, completed_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (project_id, text_no)
           DO UPDATE SET file_url = EXCLUDED.file_url, completed_at = NOW()`,
          [projectNo, stageNo, localUrl]
        );

        const cloud = { localUrl };

        if (CLOUD_TARGET === "DRIVE" || CLOUD_TARGET === "BOTH") {
          const r = await uploadToDrive(f.path, projectNo, stageNo);
          cloud.drive = r;
          if (DEV_DEBUG) console.log("[Drive] result:", r);
        }

        savedLocal.push({ url: localUrl, name: f.originalname, size: f.size, mime: f.mimetype });
        savedCloud.push(cloud);
      }

      return res.json({
        ok: true,
        files: savedLocal,
        cloud: savedCloud,
        cloudTarget: CLOUD_TARGET,
      });
    } catch (err) {
      console.error("[stage upload] error:", err);
      return res.status(500).json({
        ok: false,
        error: DEV_DEBUG ? `SERVER_ERROR: ${err?.message || err}` : "上傳失敗",
      });
    }
  }
);

// 目錄除錯
router.get(
  "/projects/:projectNo/stages/:stageNo/__debug-target",
  attachUser,
  requireAuth,
  resolveUploadTargetDir,
  (req, res) => {
    return res.json({ ok: true, uploadRoot: UPLOAD_ROOT, targetDir: req._targetDir });
  }
);

// ★ CHANGED: 匯出兩個 Router
module.exports = { router, publicRouter };
