"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const dayjs = require("dayjs");
const multer = require("multer");
const mime = require("mime-types");
const { pool } = require("../db");
const { attachUser, requireAuth } = require("../middleware/auth");

const router = express.Router();

// ★（可選）本地除錯開關：在 .env 設 DEV_DEBUG=true 可印更詳細 log
const DEV_DEBUG = (process.env.DEV_DEBUG || "false").toLowerCase() === "true";

/* ================= 對照表：階段名稱 ================= */
// 對照專案的 project_text（可依實際命名調整）
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
const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_ROOT || "public/uploads"); // ★ 建議 .env 設 D:/uploads
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20);
const ALLOWED_MIME = (process.env.ALLOWED_MIME ||
  "image/jpeg,image/png,image/webp,image/gif,application/pdf")
  .split(",")
  .map((s) => s.trim().toLowerCase());

const CLOUD_TARGET = (process.env.CLOUD_TARGET || "NONE").toUpperCase(); // ★ 建議設為 DRIVE
// Drive
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID;

// ★ 確保根目錄存在（例如 D:/uploads）
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

/* ================= 工具 ================= */
// 將實體路徑轉成對外 URL（需在 app 入口有 app.use('/uploads', express.static(UPLOAD_ROOT))）
function toPublicUrl(absPath) {
  const rel = path.relative(UPLOAD_ROOT, absPath).replace(/\\/g, "/");
  return `/uploads/${rel}`;
}

// ★ 將資料夾/檔名中的 Windows 非法字元清理，避免因 : * ? 等字元導致寫檔失敗
function safeSegment(s) {
  return String(s || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_") // 非法字元 → _
    .replace(/\s+/g, " ")                        // 多個空白壓成一個
    .trim()
    .slice(0, 80);                               // 路徑過長也會出錯，保守截斷
}

// ★ 預先計算目標資料夾：{編號_案名}/{階段編號_階段名稱} → 存在 req._targetDir
async function resolveUploadTargetDir(req, _res, next) {
  try {
    const projectNo = String(req.params.projectNo || "");
    const stageNoInt = Number(req.params.stageNo);

    // （可選）debug：看參數與根目錄
    if ((process.env.DEV_DEBUG || "false").toLowerCase() === "true") {
      console.log("[upload] params:", { projectNo, stageNoInt });
      console.log("[upload] UPLOAD_ROOT:", UPLOAD_ROOT);
    }

    // 檢查上傳根目錄可寫
    fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
    fs.accessSync(UPLOAD_ROOT, fs.constants.W_OK);

    // ★ 只查一次，用 project_id 抓 name
    const { rows } = await pool.query(
      `SELECT name FROM project WHERE project_id = $1 LIMIT 1`,
      [projectNo]
    );

    // 取到案名；取不到就用備用名稱
    const projectName = rows.length ? rows[0].name : "未命名專案";

    const stageName = STAGE_NAMES[stageNoInt] || `stage_${stageNoInt}`;

    const outerDir = `${projectNo}_${safeSegment(projectName)}`;
    const innerDir = `${stageNoInt}_${safeSegment(stageName)}`;
    const targetDir = path.join(UPLOAD_ROOT, outerDir, innerDir);

    // if ((process.env.DEV_DEBUG || "false").toLowerCase() === "true") {
    //   console.log("[upload] resolved targetDir:", targetDir);
    // }

    fs.mkdirSync(targetDir, { recursive: true });
    req._targetDir = targetDir;
    next();

  } catch (err) {
    if ((process.env.DEV_DEBUG || "false").toLowerCase() === "true") {
      console.error("[upload] resolveUploadTargetDir error:", err);
    }
    next(err);
  }
}

/* ================= Multer（磁碟存檔） ================= */
const storage = multer.diskStorage({
  // ★ 只使用 middleware 預先算好的目錄，不在這裡做任何 async/DB
  destination: (req, _file, cb) => {
    const dir = req._targetDir || UPLOAD_ROOT; // 找不到就退回根目錄，避免崩
    if (DEV_DEBUG) console.log("[upload] multer.destination ->", dir);
    cb(null, dir);
  },

  // 檔名：時間戳 + 原檔名（清理過的 base）
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const base = path
      .basename(file.originalname || "file", ext)
      .replace(/[^\w.\-]+/g, "_");
    const ts = dayjs().format("YYYYMMDD_HHmmss_SSS");
    const finalName = `${ts}_${base}${ext}`;
    if (DEV_DEBUG) console.log("[upload] multer.filename ->", finalName);
    cb(null, finalName);
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

/* ================== 雲端：Google Drive 上傳 ================== */
// ★ 僅保留 Drive；你說「暫時不要 GCS」，因此完全移除 GCS 相依，避免干擾
let drive = null;
if ((CLOUD_TARGET === "DRIVE" || CLOUD_TARGET === "BOTH") && GDRIVE_FOLDER_ID) {
  try {
    const { google } = require("googleapis");
    const auth = new google.auth.GoogleAuth({
      scopes: [
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/drive",
      ],
    });
    drive = google.drive({ version: "v3", auth });

    if (drive && DEV_DEBUG) {
      console.log("[Drive] client ready. CLOUD_TARGET=", CLOUD_TARGET, "FOLDER=", GDRIVE_FOLDER_ID);
    }
  } catch (e) {
    console.warn("[Drive] 套件/認證載入失敗，略過 Drive：", e.message);
  }
}

/**
 * 上傳到 Google Drive 並設定任何人可讀
 */
async function uploadToDrive(absPath, projectNo, stageNo) {
  if (!drive || !GDRIVE_FOLDER_ID) return { ok: false, error: "Drive 未設定" };
  try {
    const fileName = path.basename(absPath);
    const fileMeta = {
      // ★ 檔名可包含專案與階段，便於在雲端側辨識
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
      fields: "id, name, webViewLink, webContentLink",
      supportsAllDrives: true,
    });

    const fileId = createRes.data.id;

    // 連結可看
    await drive.permissions.create({
      fileId,
      resource: { role: "reader", type: "anyone" },
      supportsAllDrives: true,
    });

    const getRes = await drive.files.get({
      fileId,
      fields: "id, webViewLink, webContentLink",
      supportsAllDrives: true,
    });

    const url = getRes.data.webContentLink || getRes.data.webViewLink;
    return { ok: true, url, fileId };
  } catch (err) {

    // ★ 改這裡：帶回更具體的錯誤內容（含 status/錯誤碼）
    const e = err?.errors?.[0] || err?.response?.data?.error || err;
    const detail = typeof e === "string" ? e : (e.message || e.statusText || JSON.stringify(e));
    const code = e?.code || err?.code || err?.response?.status;
    return { ok: false, error: `DriveError${code ? `(${code})` : ""}: ${detail}` };
    
    // return { ok: false, error: String(err.message || err) };
  }
}

/* ================== 上傳 API ================== */
router.post(
  "/projects/:projectNo/stages/:stageNo/upload",
  attachUser,
  requireAuth,
  resolveUploadTargetDir,      // 先計算目錄
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
      const savedCloud = []; // 收集雲端結果（每檔一筆）

      for (const f of req.files) {
        const localUrl = toPublicUrl(f.path);

        // ★ 先 upsert 本機 URL（避免雲端失敗導致流程卡住）
        await pool.query(
          `
          INSERT INTO project_text_upload (project_id, text_no, file_url, completed_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (project_id, text_no)
          DO UPDATE SET file_url = EXCLUDED.file_url,
                        completed_at = NOW()
          `,
          [projectNo, stageNo, localUrl]
        );

        const cloud = { localUrl };

        // ★ 只推到 Drive（你現在暫時不要 GCS）
        if (CLOUD_TARGET === "DRIVE" || CLOUD_TARGET === "BOTH") {
          const r = await uploadToDrive(f.path, projectNo, stageNo);
          cloud.drive = r;

          if (DEV_DEBUG) {
            console.log("[Drive] result:", r);
          }

          // 若你想 DB 以雲端 URL 為主，可在 r.ok 時回寫一次：
          // if (r.ok) {
          //   await pool.query(
          //     `UPDATE project_text_upload
          //      SET file_url = $1, updated_at = NOW()
          //      WHERE project_id = $2 AND text_no = $3`,
          //     [r.url, projectNo, stageNo]
          //   );
          // }
        }

        savedLocal.push({
          url: localUrl,
          name: f.originalname,
          size: f.size,
          mime: f.mimetype,
        });
        savedCloud.push(cloud);
      }

      return res.json({
        ok: true,
        files: savedLocal,   // 本機對外 URL（可立即預覽）
        cloud: savedCloud,   // 雲端結果（成功/失敗）
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

// 除錯用：不經過 multer，只檢查目錄是否正確
// GET /api/projects/20250003/stages/1/__debug-target
router.get(
  "/projects/:projectNo/stages/:stageNo/__debug-target",
  attachUser,
  requireAuth,
  resolveUploadTargetDir,
  (req, res) => {
    return res.json({
      ok: true,
      uploadRoot: UPLOAD_ROOT,
      targetDir: req._targetDir,
    });
  }
);

router.get('/__whoami/drive', async (_req, res) => {
  try {
    if (!drive) return res.json({ ok:false, message:'Drive client not ready' });
    const me = await drive.about.get({ fields: 'user, storageQuota' });
    res.json({ ok:true, user: me.data.user, storageQuota: me.data.storageQuota });
  } catch (e) {
    res.json({ ok:false, error: String(e.message || e) });
  }
});

module.exports = router;
