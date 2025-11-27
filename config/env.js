// 集中讀 .env 與驗證
// Cloud Run 會在執行時注入 PORT，不被 .env 覆蓋。
// 本機開發才需要載入 .env；在 production（Cloud Run）跳過。
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const nodeEnv = process.env.NODE_ENV || "production";

const ENV = {
  nodeEnv,
  isProd: nodeEnv === "production",

  // 以 Cloud Run 提供的 PORT 為主；本機沒有時預設 8080
  PORT: Number(process.env.PORT || 8080),

  // 其他集中管理的變數可逐步加上來，例如：
  // DATABASE_URL: process.env.DATABASE_URL,
  // DRIVE_USE_SERVICE_ACCOUNT: process.env.DRIVE_USE_SERVICE_ACCOUNT === 'true',
};

module.exports = ENV;
