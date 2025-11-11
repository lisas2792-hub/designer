// server.js
// ─────────────────────────────────────────────
// 1) 環境變數集中（建議）
//    上公網：保留；若不要 /config/env.js → 用 require('dotenv').config()
// ─────────────────────────────────────────────
const ENV = require("./config/env"); // { nodeEnv, isProd, PORT }

// 2) 全域 Dayjs 設定（固定台北時區）
require("./config/dayjs"); // 初始化，不回傳

// ─────────────────────────────────────────────
// 3) 基本載入與初始化
// ─────────────────────────────────────────────
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");
const morgan = require("morgan");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

const app = express();
app.disable("x-powered-by"); // ✅ 上公網建議：隱藏框架標頭

// 保險絲（避免未攔截錯誤讓進程結束）
process.on("unhandledRejection", (err) =>
  console.error("[unhandledRejection]", err)
);
process.on("uncaughtException", (err) =>
  console.error("[uncaughtException]", err)
);

// 🔧 DEBUG: 極早期煙霧測試，驗證這支 server.js 真的在跑（穩定後可移除）
app.get("/__smoke", (_req, res) =>
  res.json({ ok: true, from: "server.js/__smoke", ts: Date.now() })
);

// ─────────────────────────────────────────────
// 4) 靜態目錄
// ─────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, "public");
const ASSETS_DIR = path.join(PUBLIC_DIR, "assets");
const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_ROOT || "public/uploads");

console.log("[BOOT] pid=%s env=%s", process.pid, process.env.NODE_ENV);

// ─────────────────────────────────────────────
// 5) DB 連線（指向資料夾 ./db → 自動載入 db/index.js）
// ─────────────────────────────────────────────
const { pool } = require("./db");

// ─────────────────────────────────────────────
// 6) 路由模組載入（只載入，不掛載）
// ─────────────────────────────────────────────
const apiRoutes = require("./routes"); // 受保護 API 的總入口（/api 前綴）
const authRoutes = require("./routes/auth"); // 公開：/api/auth/**
const opsRoutes = require("./routes/ops"); // 管理員：/__ops/**
const { attachUser, requireAuth, requireAdmin } = require("./middleware/auth");

// ✅ 安全載入 Drive 公開路由（避免 undefined 造成整體掛載中斷）
let drivePublicRouter = null; // /api/drive/**
try {
  const mod = require("./routes/stageupload"); // 你的 stageupload.js 輸出 { router, publicRouter }
  const candidate = mod?.publicRouter || mod?.router || mod?.default || null;
  if (candidate && typeof candidate.use === "function") {
    drivePublicRouter = candidate;
  } else {
    console.warn(
      "[WARN] stageupload 未輸出有效的 Express Router；略過 /api/drive 掛載"
    );
  }
} catch (e) {
  console.warn("[WARN] 無法載入 routes/stageupload：", e?.message || e);
}

// ─────────────────────────────────────────────
// 7) 通用路由追蹤器（Express 4/5 皆可）
//    ★ 修正：避免把 app.get('env') 等「設定讀取」誤記成路由
//    🔧 DEBUG: 之後穩定可註解整段
// ─────────────────────────────────────────────
const ROUTE_REGISTRY = [];
(() => {
  const httpMethods = ["get", "post", "put", "patch", "delete", "options", "head"];
  const orig = {
    use: app.use.bind(app),
    get: app.get.bind(app),
  };

  // 追蹤 app.use(path?, ...handlers)
  app.use = (maybePath, ...handlers) => {
    const isPathString = typeof maybePath === "string";
    const pathLabel = isPathString ? maybePath : "(dynamic)";
    const actualHandlers = isPathString ? handlers : [maybePath, ...handlers];
    ROUTE_REGISTRY.push({
      kind: "use",
      path: pathLabel,
      handlers: actualHandlers.length,
    });
    return orig.use(maybePath, ...handlers);
  };

  // 追蹤 GET，但過濾 app.get('setting') 這類設定讀取
  app.get = (firstArg, ...rest) => {
    if (typeof firstArg === "string" && rest.length === 0) {
      // 這是設定讀取（如 app.get('env')），不要記錄
      return orig.get(firstArg);
    }
    ROUTE_REGISTRY.push({ kind: "GET", path: firstArg, handlers: rest.length });
    return orig.get(firstArg, ...rest);
  };

  // 其他 HTTP 方法照常追蹤
  for (const m of httpMethods.filter((x) => x !== "get")) {
    const origM = app[m].bind(app);
    app[m] = (path, ...handlers) => {
      ROUTE_REGISTRY.push({
        kind: m.toUpperCase(),
        path,
        handlers: handlers.length,
      });
      return origM(path, ...handlers);
    };
  }
})();

// ─────────────────────────────────────────────
// 8) 反向代理/中介層/安全性
// ─────────────────────────────────────────────
app.set("trust proxy", 1); // 前有 Nginx/CF 時保留
app.use(morgan(ENV.isProd ? "combined" : "dev"));

// 限制請求體大小（視需求調整）
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: false, limit: "5mb" }));

// 靜態資源
app.use("/uploads", express.static(UPLOAD_ROOT));
app.use(
  "/assets",
  express.static(ASSETS_DIR, {
    maxAge: ENV.isProd ? "30d" : 0,
    etag: true,
    immutable: !!ENV.isProd,
  })
);
app.use(express.static(PUBLIC_DIR, { maxAge: 0 })); // 其他 public 檔

// HTML 不快取
app.use((req, res, next) => {
  if (req.path.endsWith(".html") || req.path === "/")
    res.set("Cache-Control", "no-store");
  next();
});

// CORS 白名單（用環境變數控制）
const allowedOrigins = (
  process.env.CORS_ORIGINS ||
  "http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:5173,http://localhost:5173"
)
  .split(",")
  .map((s) => s.trim());
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      // 上公網要更硬可改：cb(new Error('Not allowed by CORS'));
      return cb(null, false);
    },
    credentials: true,
  })
);

// Helmet（CSP 保留；HSTS 僅在 prod/https）
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"], // 開發期允許 inline
        "style-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        // "img-src": ["'self'", "data:", "https://cdn.jsdelivr.net"],
      },
    },
    hsts: ENV.isProd ? undefined : false, // 本機避免強制 https；上公網（https）請保留預設
  })
);

// 身分注入（這裡只做注入，不做阻擋）
app.use(attachUser);

// （可選）把 db 掛到 req
app.use((req, _res, next) => {
  req.db = pool;
  next();
});

// ─────────────────────────────────────────────
// 9) 限流（全域 + 登入/註冊）— 先宣告，等會再掛載
//    避免「使用前未宣告（TDZ）」問題
// ─────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    code: "RATE_LIMIT_GLOBAL",
    message: "Too many requests. Please slow down.",
  },
  skip: (req) => req.method === "OPTIONS",
});

const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    `${ipKeyGenerator(req)}:${req.body?.username ?? "unknown"}`,
  message: {
    ok: false,
    code: "RATE_LIMIT_LOGIN",
    message: "Too many login attempts. Please try again in a minute.",
  },
  skip: (req) => req.method === "OPTIONS",
});

const registerLimiter = rateLimit({
  windowMs: 60_000,
  limit: ENV.isProd ? 3 : 3000, // ✅ 上公網：3；開發：放寬
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    `${ipKeyGenerator(req)}:${req.body?.username ?? "unknown"}`,
  message: {
    ok: false,
    code: "RATE_LIMIT_REGISTER",
    message: "Too many registrations from this IP. Please try again later.",
  },
  skip: (req) => req.method === "OPTIONS" || !ENV.isProd,
  handler: (req, res) => {
    const resetSec = Number(res.get("RateLimit-Reset") || 60);
    res
      .status(429)
      .json({
        ok: false,
        code: "RATE_LIMIT_REGISTER",
        msg: "註冊太頻繁，請稍後再試",
        retryAfterSec: resetSec,
      });
  },
});

// 先保護整體（★ 必須在任何路由掛載之前）
app.use(globalLimiter);

// ─────────────────────────────────────────────
// 10) 路由掛載（公開 → 管理員 → 受保護）
// ─────────────────────────────────────────────

// 公開路由（auth + drive）
console.log("[MOUNT] /api/auth ...");
app.use("/api/auth/login", loginLimiter);
app.use("/api/auth/register", registerLimiter);
app.use("/api/auth", authRoutes);
console.log("[MOUNT] /api/auth done");

if (drivePublicRouter) {
  console.log("[MOUNT] /api/drive (publicRouter) ...");
  app.use("/api/drive", drivePublicRouter);
  console.log("[MOUNT] /api/drive done");
} else {
  console.log("[MOUNT] /api/drive skipped (no publicRouter)");
}

// 管理員路由
console.log("[MOUNT] /__ops (requireAdmin) ...");
app.use("/__ops", requireAdmin, opsRoutes);
console.log("[MOUNT] /__ops done");

// 其餘受保護 API（routes/index.js）
console.log("[MOUNT] /api (requireAuth + apiRoutes) ...");
app.use("/api", requireAuth, apiRoutes);
console.log("[MOUNT] /api protected done");

// （除錯用）無驗證探針（平行於受保護 API，用來排查 requireAuth 是否攔住）
// 🔧 DEBUG: 穩定後可移除
console.log("[MOUNT] /api (NO AUTH probe) ...");
const expressProbe = require("express").Router();
expressProbe.get("/__nopass-ping", (_req, res) =>
  res.json({ ok: true, note: "NO_AUTH_PROBE" })
);
app.use("/api", expressProbe);
console.log("[MOUNT] /api NO_AUTH_PROBE done");

// 「就緒燈」：前端健康燈請打這支（無需登入）
app.get("/api/__ready", (_req, res) => {
  res.json({
    ok: true,
    mounts: {
      auth: true,
      drive: !!drivePublicRouter,
      ops: true,
      protectedApi: true,
    },
    totalRegistered: ROUTE_REGISTRY.length,
    ts: Date.now(),
  });
});

// ─────────────────────────────────────────────
// 11) 健康檢查 / 公開資訊
// ─────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/db/ping", async (_req, res, next) => {
  try {
    const r = await pool.query("SELECT 1 AS ok");
    res.json({
      ok: true,
      db:
        r.rows?.[0]?.ok === 1 ||
        r.rows?.[0]?.ok === "1" ||
        r.rows?.length > 0,
    });
  } catch (e) {
    next(e);
  }
});

// 靜態頁面（不快取）
app.get("/login.html", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});
app.get("/register.html", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "register.html"))
);
app.get("/", (_req, res) => res.redirect("/login.html"));

// ─────────────────────────────────────────────
// 12) 診斷端點（可節流輸出，避免爆量）
//    🔧 DEBUG: 之後穩定可註解
// ─────────────────────────────────────────────
app.get("/__routes", (_req, res) => {
  try {
    const stack = app?._router?.stack;
    const results = [];

    const join = (base, seg) => {
      if (!base) return seg || "";
      if (!seg) return base;
      if (base.endsWith("/") && seg.startsWith("/"))
        return base + seg.slice(1);
      if (!base.endsWith("/") && !seg.startsWith("/"))
        return base + "/" + seg;
      return base + seg;
    };
    const pathFromRegexp = (re) => {
      if (!re) return "";
      const src = re.toString();
      const m = src.match(/\\\/([A-Za-z0-9\-\._~%]+)(?=\\\/|\)\?|\$)/);
      return m ? "/" + m[1] : "";
    };
    const walk = (stack, prefix = "") => {
      for (const layer of stack || []) {
        if (layer.route && layer.route.path != null) {
          const routePaths = Array.isArray(layer.route.path)
            ? layer.route.path
            : [layer.route.path];
          const methods = Object.keys(layer.route.methods || {})
            .filter((m) => layer.route.methods[m])
            .map((m) => m.toUpperCase())
            .sort();
          for (const p of routePaths)
            results.push({ methods, path: join(prefix, p) });
          continue;
        }
        const handle = layer.handle;
        const child =
          handle && Array.isArray(handle.stack) ? handle.stack : null;
        if (child) {
          const mount = layer.path || pathFromRegexp(layer.regexp) || "";
          walk(child, join(prefix, mount));
        }
      }
    };

    if (Array.isArray(stack) && stack.length) {
      walk(stack, "");
      const MAX = 400;
      return res.json({
        ok: true,
        source: "introspection",
        count: results.length,
        routes: results.slice(0, MAX),
        truncated: results.length > MAX,
      });
    }

    const MAX = 400;
    return res.json({
      ok: true,
      source: "registry",
      count: ROUTE_REGISTRY.length,
      routes: ROUTE_REGISTRY.slice(0, MAX).map((r) => ({
        methods: [r.kind],
        path: r.path,
        handlers: r.handlers,
      })),
      truncated: ROUTE_REGISTRY.length > MAX,
    });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: "SERVER_ERROR", detail: String(e?.message || e) });
  }
});

// 完整登記簿（小心很長）— 🔧 DEBUG: 之後可註解
app.get("/__routes_registry", (_req, res) => {
  res.json({ ok: true, total: ROUTE_REGISTRY.length, routes: ROUTE_REGISTRY });
});

// ─────────────────────────────────────────────
// 13) 404 & 全域錯誤處理
// ─────────────────────────────────────────────
app.use((req, res) => {
  res.set("X-From-404", "server.js");
  res
    .status(404)
    .json({ ok: false, message: "Not Found", path: req.originalUrl });
});

app.use((err, req, res, _next) => {
  console.error("[UNCAUGHT ERROR]", req.method, req.originalUrl, err);
  res
    .status(err.status || 500)
    .json({ ok: false, error: "SERVER_ERROR", detail: String(err?.message || err) });
});

// ─────────────────────────────────────────────
// 14) 啟動 & 啟動自檢（以登記簿為主，不再依賴私有屬性）
// ─────────────────────────────────────────────
app.listen(ENV.PORT, "0.0.0.0", () => {
  console.log(
    `API on http://0.0.0.0:${ENV.PORT} (env:${ENV.nodeEnv}) [build:${Date.now()}]`
  );

  // 用登記簿輸出前 20 條掛載摘要（Express 4/5 都可靠）
  try {
    const list = ROUTE_REGISTRY.slice(0, 20).map(
      (r) => `${r.kind} ${r.path} [handlers:${r.handlers}]`
    );
    console.log("[ROUTES REGISTRY]", list);
    if (!ROUTE_REGISTRY.length) {
      console.warn(
        "[WARN] 目前沒有掛載任何具體路由。請檢查 routes/index.js 與各子路由是否有 `module.exports = router`。"
      );
    }
  } catch (e) {
    console.warn("[ROUTES] 列印失敗：", e?.message || e);
  }
});
