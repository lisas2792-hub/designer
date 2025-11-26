// // 專門負責與 PostgreSQL 連線
// const { Pool } = require("pg");

// // 讀取環境變數（建議透過 /config/env.js 管理）
// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   // 若在雲端資料庫常需要下列 SSL 設定；本機多半關閉
//   // ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
// });

// // 捕捉閒置連線錯誤
// pool.on("error", (err) => {
//   console.error("[DB] Unexpected error on idle client", err);
// });

// // 啟動時測試連線
// pool.query("SELECT 1")
//   .then(() => console.log("[DB] Connected successfully ✅"))
//   .catch(err => console.error("[DB] Connection error ❌", err));

// module.exports = { pool };


// NEW
// 統一管理 PostgreSQL 連線（Neon / Cloud Run / 本機）
// ==========================================
"use strict";

const { Pool } = require("pg");

// 從環境變數拿設定
const {
  DATABASE_URL,
  DB_HOST,
  DB_PORT,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  DB_SSL,
} = process.env;

/**
 * 組出 Pool 設定
 * 優先使用 DATABASE_URL，其次才用 DB_HOST / DB_USER 這組
 */
function buildPoolConfig() {
  // ✅ 1) 有 DATABASE_URL 的話，優先用這個（推薦做法）
  if (DATABASE_URL) {
    const useSsl =
      DATABASE_URL.includes("sslmode=require") ||
      String(DB_SSL).toLowerCase() === "true";

    const config = {
      connectionString: DATABASE_URL,
    };

    if (useSsl) {
      // Neon 這種雲端 PG 通常要開 SSL，但不用驗證憑證
      config.ssl = { rejectUnauthorized: false };
    }

    return config;
  }

  // 2) 沒 DATABASE_URL 時，退回用 DB_* 這組
  if (DB_HOST && DB_USER && DB_NAME) {
    const useSsl = String(DB_SSL).toLowerCase() === "true";

    const config = {
      host: DB_HOST,
      port: DB_PORT ? Number(DB_PORT) : 5432,
      user: DB_USER,
      // ⚠️ 強制轉成字串，避免出現「password must be a string」錯誤
      password: DB_PASSWORD !== undefined ? String(DB_PASSWORD) : "",
      database: DB_NAME,
    };

    if (useSsl) {
      config.ssl = { rejectUnauthorized: false };
    }

    return config;
  }

  // 3) 兩種都沒有就直接丟錯，避免用 undefined 亂連
  throw new Error(
    "[DB] 找不到 DATABASE_URL 或 DB_HOST/DB_USER/DB_NAME，請確認環境變數設定是否正確"
  );
}

const poolConfig = buildPoolConfig();
const pool = new Pool(poolConfig);

// 監聽 idle client 的錯誤（正式環境建議保留）
pool.on("error", (err) => {
  console.error("[DB] Unexpected error on idle client", err);
});

// 啟動時測試一次連線（方便 debug）
(async () => {
  try {
    await pool.query("SELECT 1");
    console.log("[DB] ✅ PostgreSQL 連線成功");
  } catch (err) {
    console.error("[DB] ❌ PostgreSQL 連線失敗", err);
  }
})();

module.exports = { pool };
