// 放註冊 / 登入的 API
const { Router } = require("express");
const bcrypt = require("bcrypt");
const { pool } = require("../db");

const router = Router();

// === JWT 與 Cookie 解析 ===
const jwt = require("jsonwebtoken");
const cookie = require("cookie"); // 只用來解析 Cookie header
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_IN_PROD";
const JWT_EXPIRES = "7d"; // 可調整

// ⬅️ 新增：環境旗標與共用 Cookie 設定建構函式（正式環境支援跨站 Cookie）
const IS_PROD = process.env.NODE_ENV === "production";
/**
 * 依環境組裝安全的 Cookie 參數：
 * - 開發：SameSite=Lax、非 HTTPS 也可測（前後端建議同主機名，如都用 127.0.0.1）
 * - 正式：SameSite=None + Secure（必須 HTTPS），以支援跨網域前端
 */
function buildCookieOptions(maxAgeSec) { // ⬅️
  return {
    httpOnly: true,
    path: "/",
    maxAge: maxAgeSec,
    sameSite: IS_PROD ? "none" : "lax",
    secure: IS_PROD ? true : false,
  };
}

/** 註冊 */
router.post("/register", async (req, res) => {
  const { name, username, password } = req.body || {};
  if (!name || !username || !password) {
    return res.status(400).json({ ok: false, msg: "缺少必填欄位" });
  }

  try {
    // 帳號唯一性
    const exist = await pool.query(
      `SELECT 1 FROM "user" WHERE username = $1`,
      [username]
    );
    if (exist.rowCount > 0) {
      return res.status(409).json({ ok: false, msg: "帳號已存在" });
    }

    // 取角色（一次把 member / admin 都查出來）
    const roles = await pool.query(
      `SELECT id, code FROM user_role WHERE code IN ('member','admin')`
    );
    const memberRoleId = roles.rows.find(r => r.code === "member")?.id;
    const adminRoleId  = roles.rows.find(r => r.code === "admin")?.id;

    if (!memberRoleId) {
      return res.status(500).json({ ok: false, msg: "系統缺少 user_role.member，請先初始化" });
    }
    if (!adminRoleId) {
      return res.status(500).json({ ok: false, msg: "系統缺少 user_role.admin，請先初始化" });
    }

    // 使用者總數（第一位給 admin，其餘給 member）
    const countRow = await pool.query(`SELECT COUNT(*)::int AS count FROM "user"`);
    const userCount = countRow.rows[0]?.count ?? 0;
    const roleId = userCount === 0 ? adminRoleId : memberRoleId;

    // bcrypt hash(bcrypt 演算法做單向加密（雜湊 hash）)
    const rounds = Number(process.env.BCRYPT_ROUNDS || 12);
    const hashed = await bcrypt.hash(password, rounds);

    // 新增使用者
    const insert = await pool.query(
      `INSERT INTO "user"(name, username, password, role_id)
       VALUES ($1,$2,$3,$4)
       RETURNING id, name, username, role_id, is_active, created_at`,
      [name, username, hashed, roleId]
    );

    return res.status(201).json({
      ok: true,
      msg: "註冊成功",
      user: insert.rows[0],
    });
  } catch (err) {
    console.error("[register] error:", err);
    return res.status(500).json({ ok: false, msg: "註冊失敗" });
  }
});

/** 登入 */
router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, msg: "缺少必填欄位" });
  }

  try {
    // 取使用者（包含密碼雜湊）--JOIN 取出角色代碼 role_code
    const result = await pool.query(
      `SELECT u.id, u.name, u.username, u.password, u.role_id, u.is_active, u.created_at,
              r.code AS role_code
       FROM "user" u
       JOIN user_role r ON r.id = u.role_id
       WHERE u.username = $1
       LIMIT 1`,
      [username]
    );
    if (result.rowCount === 0) {
      return res.status(400).json({ ok: false, msg: "帳號或密碼錯誤" });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ ok: false, msg: "帳號或密碼錯誤" });
    }
    if (user.is_active === false) {
      return res.status(403).json({ ok: false, msg: "帳號未啟用或已停用" });
    }

    // === 簽發 JWT，放在 HttpOnly Cookie ===
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role_code },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    // 安全 Cookie（正式環境請確保 HTTPS，再把 secure 設 true）
    // res.setHeader(
    //   "Set-Cookie",
    //   cookie.serialize("auth", token, {
    //     httpOnly: true,
    //     sameSite: "lax",
    //     secure: process.env.NODE_ENV === "production",
    //     path: "/",
    //     maxAge: 7 * 24 * 60 * 60, // 7d
    //   })
    // );
    // ⬅️ 改用共用函式，依環境自動給 SameSite/secure
    res.setHeader(
      "Set-Cookie",
      cookie.serialize("auth", token, buildCookieOptions(7 * 24 * 60 * 60))
    );

    const { password: _, ...safeUser } = user;
    return res.json({ ok: true, user: safeUser, token });
  } catch (err) {
    console.error("[login] error:", err);
    return res.status(500).json({ ok: false, msg: "登入失敗" });
  }
});

/** 登出（清掉 Cookie） */
router.post("/logout", (_req, res) => {
  // res.setHeader(
  //   "Set-Cookie",
  //   cookie.serialize("auth", "", {
  //     httpOnly: true,
  //     sameSite: "lax",
  //     secure: process.env.NODE_ENV === "production",
  //     path: "/",
  //     maxAge: 0,
  //   })
  // );
  // ⬅️ 改用共用函式清除 Cookie（maxAge=0）
  res.setHeader(
    "Set-Cookie",
    cookie.serialize("auth", "", { ...buildCookieOptions(0), maxAge: 0 })
  );
  res.json({ ok: true });
});

/** 目前登入者資訊（由 JWT 解析來） */
router.get("/me", (req, res) => {
  const c = req.headers.cookie ? cookie.parse(req.headers.cookie) : {};
  const token = c.auth;
  if (!token) return res.status(401).json({ ok: false, msg: "UNAUTHORIZED" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // 若要回更完整的 user，可再查DB；一般顯示用回 payload 即可
    return res.json({
      ok: true,
      data: { id: payload.id, username: payload.username, role: payload.role },
    });
  } catch {
    return res.status(401).json({ ok: false, msg: "UNAUTHORIZED" });
  }
});

// 健康檢查：確認這支路由有掛上（實際路徑 /api/auth/auth-ping）
router.get("/auth-ping", (_req, res) => {
  console.log("[auth] /auth-ping hit");
  res.json({ ok: true });
});


// === 新增middleware ===
function attachUser(req, _res, next) {
  try {

    // 先從 Cookie 取 token（正常 http://127.0.0.1 用這個）
    const c = req.headers.cookie ? cookie.parse(req.headers.cookie) : {};
    const token = c.auth;

    // 若 Cookie 沒有，再從 Authorization header 取（for file://）
    if (!token && req.headers.authorization) {
      const m = req.headers.authorization.match(/^Bearer\s+(.+)$/i);
      if (m) token = m[1];
    }

    if (!token) return next();

    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: payload.id,
      username: payload.username,
      role: payload.role, // 'admin' 或 'member'
    };
  } catch {
    // token 錯誤就略過，保持未登入狀態
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ ok: false, msg: "UNAUTHORIZED" });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ ok: false, msg: "FORBIDDEN" });
  }
  next();
}

// 將 middleware 掛在 router 上供外部使用
router.attachUser = attachUser;
router.requireAuth = requireAuth;
router.requireAdmin = requireAdmin;

module.exports = router;
