// 集中讀 .env 與驗證
require('dotenv').config();

const nodeEnv = process.env.NODE_ENV || 'development';

const ENV = {
  nodeEnv,
  isProd: nodeEnv === 'production',
  PORT: Number(process.env.PORT || 3000),
  // 其他需要用到的集中在這裡（可逐步擴充）
  // DB_URL: process.env.DATABASE_URL, ← 目前你用的是 process.env.DATABASE_URL，保留在 db/index.js 即可
};

module.exports = ENV;