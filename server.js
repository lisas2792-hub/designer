// ---- 全域錯誤攔截（放在最前面）----
// process.on("uncaughtException", err => {
//   console.error("[FATAL] uncaughtException:", err);
// });
// process.on("unhandledRejection", r => {
//   console.error("[FATAL] unhandledRejection:", r);
// });


// server.js 入口檔
require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const path      = require("path");
const morgan    = require('morgan');

const app  = express();



console.log("[BOOT main] pid:", process.pid, "cwd:", process.cwd());





// ❌ 錯誤：這行拿到的是整個 module，而不是 pool 實例
// const pool = require("./db");

// ✅ 修正：你的 db.js 若是 `module.exports = { pool }`，就要用解構
const { pool } = require("./db"); 

const userRouter = require("./routes/user");
const authRoutes = require("./routes/auth");
const opsRoutes  = require("./routes/ops");
const meRoutes   = require("./routes/me");
const projectsRouter = require("./routes/projects");
const responsibleUserRoute = require("./routes/responsibleuser");

// CJS (CommonJS)
// v8 正確匯入
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');


// 當開發時註冊(為了不被限流特別設定)
const isProd = process.env.NODE_ENV === 'production';
console.log('[ENV]', { NODE_ENV: process.env.NODE_ENV, isProd });


// 反向代理（例如 Nginx / Render / Vercel），需打開 trust proxy
app.set("trust proxy", 1);

// ------- 基本中介層（順序：parser -> 靜態 -> 安全/CORS -------
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static("public"));


app.use(cors({
  origin: ['http://127.0.0.1:3000', 'http://localhost:3000', 'http://127.0.0.1:5173', 'http://localhost:5173'],
  credentials: true
}));


// Helmet（開發期允許 inline，之後可移除 unsafe-inline）
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "script-src": ["'self'", "'unsafe-inline'"],
      "style-src" : ["'self'", "'unsafe-inline'"],
    },
  },
}));


app.use((req, _res, next) => {
  req.db = pool;
  next();
});

// 每次請求都印 log
// app.use((req, _res, next) => {
//   console.log(`[REQ] ${req.method} ${req.url}`);
//   next();
// });







// 列出所有註冊的路由（安全版）
app.get('/__routes', (req, res) => {
  try {
    const list = [];
    const stack = app._router?.stack || [];   // 避免 undefined

    for (const layer of stack) {
      if (layer.route && layer.route.path) {
        // 直接掛在 app 上的路由
        const methods = Object.keys(layer.route.methods || {})
          .filter(Boolean).map(m => m.toUpperCase());
        list.push({ methods, path: layer.route.path });
      } else if (layer.name === 'router' && layer.handle?.stack) {
        // 由 Router() 匯入的子路由
        for (const r of layer.handle.stack) {
          if (r.route?.path) {
            const methods = Object.keys(r.route.methods || {})
              .filter(Boolean).map(m => m.toUpperCase());
            list.push({ methods, path: r.route.path });
          }
        }
      }
    }

    res.json({ ok: true, count: list.length, routes: list });
  } catch (e) {
    // 這裡也不要動到 e.stack，避免 e 是字串或 undefined
    res.status(500).json({
      ok: false,
      error: 'SERVER_ERROR',
      detail: String(e?.message || e),
    });
  }
});










/* ---------------- 健康檢查：一定要放在 404 之前 ---------------- */
// 健康檢查 server
app.get("/health", (_req, res) => res.json({ ok: true }));// 健康檢查（只測 server）


// DB 健康檢查（直接打資料庫）
app.get("/api/db/ping", async (_req, res, next) => {
  try {
    const r = await pool.query("SELECT 1 AS ok");
    //查詢成功就回 ok:true
    res.json({ ok: true, db: r.rows?.[0]?.ok === 1 || r.rows?.[0]?.ok === "1" || r.rows?.length > 0 });
  } catch (e) {
    next(e);
  }
});


// ==================== 限流組態 ====================

// 全域限流：同一 IP 每分鐘最多 100 次（依需求調整）
const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 100,
  standardHeaders: true,     // 在回應新增 RateLimit-* header
  legacyHeaders: false,      // 移除 X-RateLimit-* header
  message: {
    ok: false,
    code: "RATE_LIMIT_GLOBAL",
    message: "Too many requests. Please slow down.",
  },
  skip: (req) => req.method === "OPTIONS",         // 預檢不計數
});

// 登入限流：同一(IP+username) 每分鐘最多 5 次
const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  // 以「IP + username key；沒帶 username 時用 unknown
  keyGenerator: (req) => `${ipKeyGenerator(req)}:${req.body?.username ?? 'unknown'}`,
  message: {
    ok: false,
    code: "RATE_LIMIT_LOGIN",
    message: "Too many login attempts. Please try again in a minute.",
  },
  skip: (req) => req.method === "OPTIONS",
});

// 註冊限流：同一(IP+username) 每分鐘最多 3 次
const registerLimiter = rateLimit({
  windowMs: 60_000,
  limit: isProd ? 3 : 3000, //開發期放寬
  // limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req)}:${req.body?.username ?? 'unknown'}`,
  message: {
    ok: false,
    code: "RATE_LIMIT_REGISTER",
    message: "Too many registrations from this IP. Please try again later.",
  },
  skip: (req) => req.method === "OPTIONS" || !isProd,   // 同時略過「預檢」以及「開發環境」
  handler: (req, res) => {
    const resetSec = Number(res.get('RateLimit-Reset') || 60);
    res.status(429).json({
      ok: false,
      code: 'RATE_LIMIT_REGISTER',
      msg: '註冊太頻繁，請稍後再試',
      retryAfterSec: resetSec,
    });
  },
});


// 先掛全域限流（放最前面保護所有 API）
app.use(globalLimiter);

// 再掛針對路徑的限流（只限 login / register）
app.use("/api/auth/login", loginLimiter);
app.use("/api/auth/register", registerLimiter);

// 登入、註冊都走這裡
app.use("/api/auth", authRoutes);

// 只留 health 或未來的使用者 CRUD
app.use("/api/users", userRouter);

// 一次性初始化
app.use("/__ops", opsRoutes);

//會員名稱
app.use("/api", meRoutes);

// 新增專案時的負責人下拉選單
app.use("/api/responsible-user", responsibleUserRoute);

// 專案 CRUD(載入 新增 更新 等等)
app.use("/api", projectsRouter);

// 靜態頁面
app.get("/login.html",  (_req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/register.html",(_req, res) => res.sendFile(path.join(__dirname, "public", "register.html")));
app.get("/", (_req, res) => res.redirect("/login.html"));


// ---------- 404 與錯誤處理（一定要放在所有路由之後，避免提前攔截） ----------
app.use((req, res) => {
  res.set('X-From-404', 'server.js');
  res.status(404).json({ ok: false, message: 'Not Found', path: req.originalUrl });
});

// ✅ 全域 Express 錯誤處理(開發期用）
app.use((err, req, res, next) => {
  console.error('[UNCAUGHT ERROR]', req.method, req.originalUrl, err); // 看完整 stack
  res.status(err.status || 500).json({
    ok: false,
    error: 'SERVER_ERROR',
    detail: String(err?.message || err),// 上線時拿掉 detail
  });
});


// ------- 啟動 -------
const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(`API on http://0.0.0.0:${port} [build:${Date.now()}]`);
  console.log(`   Try: /health`);
  console.log(`   Try: /api/db/ping`);
});



// // ------- 啟動(簡略) -------
// const port = Number(process.env.PORT || 3000);
// app.listen(port, "0.0.0.0", () => console.log(`API on http://0.0.0.0:${port}`));
