// 專門負責與 PostgreSQL 連線
const { Pool } = require("pg");

// 讀取環境變數（建議透過 /config/env.js 管理）
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // 若在雲端資料庫常需要下列 SSL 設定；本機多半關閉
  // ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

// 捕捉閒置連線錯誤
pool.on("error", (err) => {
  console.error("[DB] Unexpected error on idle client", err);
});

// 啟動時測試連線
pool.query("SELECT 1")
  .then(() => console.log("[DB] Connected successfully ✅"))
  .catch(err => console.error("[DB] Connection error ❌", err));

module.exports = { pool };
