"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const dayjs = require("dayjs");
const multer = require("multer");
const mime = require("mime");
const { pool } = require("../db");
const { attachUser, requireAuth } = require("../middleware/auth");

const router = express.Router();

/* ================= 路徑與環境 ================= */
const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_ROOT || "public/uploads");
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20);
const ALLOWED_MIME = (process.env.ALLOWED_MIME ||
  "image/jpeg,image/png,image/webp,image/gif,application/pdf")
  .split(",")
  .map((s) => s.trim().toLowerCase());

const CLOUD_TARGET = (process.env.CLOUD_TARGET || "NONE").toUpperCase(); // NONE|GCS|DRIVE|BOTH

// GCS
const GCS_BUCKET = process.env.GCS_BUCKET;
const GCS_PREFIX = process.env.GCS_PREFIX || "";

// Drive
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID;

// 確保根目錄存在
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

/* ================= 工具 ================= */
function ensureStageDir(projectNo, stageNo) {
  const dir = path.join(UPLOAD_ROOT, String(projectNo), String(stageNo));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
// function ensureStageDir(projectNo, stageNo) {
//   const stageName = STAGE_NAMES[stageNo] || `stage_${stageNo}`;
//   const dir = path.join(UPLOAD_ROOT, String(projectNo), stageName); // ← 這裡可換命名結構
//   fs.mkdirSync(dir, { recursive: true });
//   return dir;
// }

function toPublicUrl(absPath) {
  const rel = path.relative(UPLOAD_ROOT, absPath).replace(/\\/g, "/");
  return `/uploads/${rel}`;
}

/* ================= Multer（磁碟存檔） ================= */
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const { projectNo, stageNo } = req.params;
    try {
      const dir = ensureStageDir(projectNo, stageNo);
      cb(null, dir);
    } catch (e) {
      cb(e);
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const base = path
      .basename(file.originalname || "file", ext)
      .replace(/[^\w.\-]+/g, "_");
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

/* ================== 雲端：GCS 上傳 ================== */
let gcsStorage = null;
if ((CLOUD_TARGET === "GCS" || CLOUD_TARGET === "BOTH") && GCS_BUCKET) {
  try {
    const { Storage } = require("@google-cloud/storage");
    gcsStorage = new Storage(); // GOOGLE_APPLICATION_CREDENTIALS 由環境變數指定
  } catch (e) {
    console.warn("[GCS] 套件載入失敗，略過 GCS：", e.message);
  }
}

/**
 * 上傳到 GCS
 * @param {string} absPath 本機絕對路徑
 * @param {string} projectNo
 * @param {number} stageNo
 * @returns {Promise<{ok:boolean, url?:string, error?:string}>}
 */
async function uploadToGCS(absPath, projectNo, stageNo) {
  if (!gcsStorage || !GCS_BUCKET) return { ok: false, error: "GCS 未設定" };
  try {
    const fileName = path.basename(absPath);
    const prefix = GCS_PREFIX ? `${GCS_PREFIX}/` : "";
    const dst = `${prefix}${projectNo}/${stageNo}/${fileName}`;

    const bucket = gcsStorage.bucket(GCS_BUCKET);
    await bucket.upload(absPath, {
      destination: dst,
      resumable: false,
      metadata: {
        contentType: mime.getType(absPath) || "application/octet-stream",
        cacheControl: "public, max-age=31536000, immutable",
      },
    });

    // 若 bucket 設定是 public，這個 URL 可直接存取
    const url = `https://storage.googleapis.com/${GCS_BUCKET}/${encodeURI(dst)}`;
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

/* ================== 雲端：Google Drive 上傳 ================== */
let drive = null;
if ((CLOUD_TARGET === "DRIVE" || CLOUD_TARGET === "BOTH") && GDRIVE_FOLDER_ID) {
  try {
    const { google } = require("googleapis");
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/drive"],
    });
    drive = google.drive({ version: "v3", auth });
  } catch (e) {
    console.warn("[Drive] 套件/認證載入失敗，略過 Drive：", e.message);
  }
}

/**
 * 上傳到 Google Drive 並設定任何人可讀
 * @param {string} absPath
 * @param {string} projectNo
 * @param {number} stageNo
 * @returns {Promise<{ok:boolean, url?:string, fileId?:string, error?:string}>}
 */
async function uploadToDrive(absPath, projectNo, stageNo) {
  if (!drive || !GDRIVE_FOLDER_ID) return { ok: false, error: "Drive 未設定" };
  try {
    const fileName = path.basename(absPath);
    const fileMeta = {
      name: `${projectNo}_${stageNo}_${fileName}`,
      parents: [GDRIVE_FOLDER_ID],
    };
    const media = {
      mimeType: mime.getType(absPath) || "application/octet-stream",
      body: fs.createReadStream(absPath),
    };
    const createRes = await drive.files.create({
      resource: fileMeta,
      media,
      fields: "id, name, webViewLink, webContentLink",
      supportsAllDrives: true,
    });

    const fileId = createRes.data.id;

    // 設定公開讀取（連結可看）
    await drive.permissions.create({
      fileId,
      resource: { role: "reader", type: "anyone" },
      supportsAllDrives: true,
    });

    // 取可下載連結（或用 webViewLink）
    const getRes = await drive.files.get({
      fileId,
      fields: "id, webViewLink, webContentLink",
      supportsAllDrives: true,
    });

    const url = getRes.data.webContentLink || getRes.data.webViewLink;
    return { ok: true, url, fileId };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

/* ================== 上傳 API ================== */
router.post(
  "/projects/:projectNo/stages/:stageNo/upload",
  attachUser,
  requireAuth,
  upload.array("files", 10),
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

      // 每檔寫 DB（以本機 URL 為主，若你想改存雲端 URL，下面有說明）
      for (const f of req.files) {
        const localUrl = toPublicUrl(f.path);
        // 先 upsert 本機 URL（確保「完成」邏輯不被雲端失敗影響）
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

        // 依設定推雲端（不影響主流程）
        if (CLOUD_TARGET === "GCS" || CLOUD_TARGET === "BOTH") {
          const r = await uploadToGCS(f.path, projectNo, stageNo);
          cloud.gcs = r;
          // 若你想「DB 優先存雲端 URL」→ r.ok 再回寫一次：
          // if (r.ok) {
          //   await pool.query(
          //     `UPDATE project_text_upload SET file_url=$1, updated_at=NOW() WHERE project_id=$2 AND text_no=$3`,
          //     [r.url, projectNo, stageNo]
          //   );
          // }
        }
        if (CLOUD_TARGET === "DRIVE" || CLOUD_TARGET === "BOTH") {
          const r = await uploadToDrive(f.path, projectNo, stageNo);
          cloud.drive = r;
          // 同上，若偏好 DB 儲存 Drive 連結可在 r.ok 時回寫
        }

        savedLocal.push({ url: localUrl, name: f.originalname, size: f.size, mime: f.mimetype });
        savedCloud.push(cloud);
      }

      return res.json({
        ok: true,
        files: savedLocal,  // 本機對外 URL（可立即預覽）
        cloud: savedCloud,  // 雲端結果詳細（成功/失敗）
        cloudTarget: CLOUD_TARGET,
      });
    } catch (err) {
      console.error("[stage upload] error:", err);
      return res.status(500).json({ ok: false, error: err?.message || "上傳失敗" });
    }
  }
);

module.exports = router;
