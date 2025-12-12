// config/env.js
// 集中處理環境變數：本機載入 .env、標準化布林與數值、提供預設 PORT

// 1) 只在非 production 載入 .env（本機除錯用）
const nodeEnv = process.env.NODE_ENV || 'development';
if (nodeEnv !== 'production') {
  // 不用 top-level await；CommonJS 直接 require
  require('dotenv').config();
}

// 2) 標準化
const isProd = nodeEnv === 'production';
const PORT = Number(process.env.PORT) || 3000; // 本機預設 3000；Cloud Run 會注入 PORT=8080

// 3) 可選：把重點旗標轉成布林（避免字串 'false' 被當成 true）
const asBool = (v) => {
  if (typeof v === 'boolean') return v;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
};

const DRIVE_USE_SERVICE_ACCOUNT = asBool(process.env.DRIVE_USE_SERVICE_ACCOUNT);

// 4) 匯出給 server.js 使用
module.exports = {
  nodeEnv,
  isProd,
  PORT,
  DRIVE_USE_SERVICE_ACCOUNT,
};
