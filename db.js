// 專門負責跟 PostgreSQL 連線

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // 若在雲端資料庫常需要下列 SSL 設定；本機多半關閉
  // ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

pool.on("error", (err) => {
  console.error("[db] Unexpected error on idle client", err);
});


// 測試連線
pool.query("SELECT 1")
  .then(() => {
    console.log("[DB] Connected successfully ✅");
  })
  .catch(err => {
    console.error("[DB] Connection error ❌", err);
  });

module.exports = { pool };
