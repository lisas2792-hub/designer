// routes/stageupload.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Storage } = require('@google-cloud/storage');

const dayjs = require('dayjs');
const router = express.Router();
const { pool } = require('../db');
const { attachUser, requireAuth } = require('../middleware/auth');

const UPLOAD_ROOT = process.env.UPLOAD_ROOT || '/var/www/uploads';
const PUBLIC_BASE = process.env.PUBLIC_UPLOAD_BASE || '/uploads';
const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 15);
const GCS_BUCKET = process.env.GCS_BUCKET || '';

/* ---------- 安全設定 ---------- */
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'
]);

function fileFilter(_req, file, cb) {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return cb(new Error('不支援的檔案格式'));
  }
  cb(null, true);
}

/* ---------- Local：diskStorage ---------- */
const diskStorage = multer.diskStorage({
  destination: async (req, _file, cb) => {
    const { projectId } = req.params;
    const dir = path.join(UPLOAD_ROOT, String(projectId));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ts = dayjs().format('YYYYMMDD_HHmmss_SSS');
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    cb(null, `${ts}${ext}`);
  }
});

/* ---------- GCS：memoryStorage + 上傳 ---------- */
const memUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: MAX_MB * 1024 * 1024 }
});

let gcs = null;
if (GCS_BUCKET) {
  gcs = new Storage(); // 依 GOOGLE_APPLICATION_CREDENTIALS 自動讀取
}

/* 共同：本機上傳器（disk） */
const diskUpload = multer({
  storage: diskStorage,
  fileFilter,
  limits: { fileSize: MAX_MB * 1024 * 1024 }
});

/* ---------- 寫 DB（UPSERT） ---------- */
async function upsertUpload({ projectId, stageNo, fileUrl }) {
  const sql = `
    INSERT INTO project_text_upload (project_id, text_no, file_url, completed_at, created_at, updated_at)
    VALUES ($1, $2, $3, NOW(), NOW(), NOW())
    ON CONFLICT (project_id, text_no) DO UPDATE
    SET file_url = EXCLUDED.file_url,
        completed_at = EXCLUDED.completed_at,
        updated_at = NOW()
    RETURNING project_id, text_no, file_url, completed_at;
  `;
  const { rows } = await pool.query(sql, [String(projectId), Number(stageNo), fileUrl || null]);
  return rows[0];
}

/* ---------- API：完成 + 上傳 ---------- */
/**
 * POST /api/projects/:projectId/stages/:stageNo/upload?dest=local|gcs
 * multipart/form-data; field: photo
 */
router.post(
  '/projects/:projectId/stages/:stageNo/upload',
  attachUser, requireAuth,
  async (req, res, next) => {
    try {
      const dest = (req.query.dest || 'local').toString().toLowerCase();
      if (dest === 'gcs' && !gcs) {
        return res.status(400).json({ ok: false, msg: '未設定 GCS_BUCKET，無法使用 gcs 上傳' });
      }

      // 選擇對應的 multer
      const uploader = (dest === 'gcs') ? memUpload.single('photo') : diskUpload.single('photo');
      uploader(req, res, async (err) => {
        if (err) {
          return res.status(400).json({ ok: false, msg: err.message || '上傳失敗' });
        }

        const { projectId, stageNo } = req.params;

        let fileUrl = null;

        if (dest === 'local') {
          if (!req.file || !req.file.path) {
            return res.status(400).json({ ok: false, msg: '找不到檔案' });
          }
          // 建立對外可存取的 URL（靜態服務路徑）
          const relPath = path.relative(UPLOAD_ROOT, req.file.path).split(path.sep).join('/');
          fileUrl = `${PUBLIC_BASE}/${relPath}`; // e.g. /uploads/24/20250101_120000_000.jpg
        } else {
          // gcs：把 buffer 上傳到 bucket
          if (!req.file || !req.file.buffer) {
            return res.status(400).json({ ok: false, msg: '找不到檔案' });
          }
          const ts = dayjs().format('YYYYMMDD_HHmmss_SSS');
          const ext = path.extname(req.file.originalname || '').toLowerCase() || '.jpg';
          const objectName = `${projectId}/${ts}${ext}`;

          const bucket = gcs.bucket(GCS_BUCKET);
          const file = bucket.file(objectName);

          await file.save(req.file.buffer, {
            contentType: req.file.mimetype,
            public: true, // 若你要私有存取，改成 false + 產生簽章網址
            metadata: { cacheControl: 'public, max-age=31536000' }
          });

          fileUrl = `https://storage.googleapis.com/${GCS_BUCKET}/${encodeURIComponent(objectName)}`;
        }

        // 寫入/覆蓋 DB
        const row = await upsertUpload({ projectId, stageNo, fileUrl });

        return res.json({ ok: true, data: row });
      });
    } catch (e) {
      next(e);
    }
  }
);

/* ---------- API：只標記完成（無檔案）保留給你既有流程 ---------- */
/**
 * POST /api/projects/:projectId/stages/:stageNo/complete
 * body: { file_url?: string|null }
 */
router.post(
  '/projects/:projectId/stages/:stageNo/complete',
  attachUser, requireAuth,
  async (req, res) => {
    try {
      const { projectId, stageNo } = req.params;
      const { file_url } = req.body || {};
      const row = await upsertUpload({ projectId, stageNo, fileUrl: file_url || null });
      res.json({ ok: true, data: row });
    } catch (e) {
      console.error('[stage complete] error:', e);
      res.status(500).json({ ok: false, msg: 'server error' });
    }
  }
);

module.exports = router;
