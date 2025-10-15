// 放註冊 / 登入的 API
const { Router } = require("express");
const bcrypt = require("bcrypt");
const { pool } = require("../db");

const router = Router();

// === JWT 與 Cookie 解析 ===
const jwt = require("jsonwebtoken");
const cookie = require("cookie"); // 只用來解析 Cookie header
const { requireAuth } = require("../middleware/auth");

// 環境旗標與共用 Cookie 設定建構函式（公網/正式環境用 HTTPS 才能跨網域）
const IS_PROD = process.env.NODE_ENV === "production";
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_IN_PROD";
const JWT_EXPIRES = "7d";// 可調整
/**
 * 依環境組裝安全的 Cookie 參數：
 * - 開發：SameSite=Lax、非 HTTPS 也可測（前後端建議同主機名，如都用 127.0.0.1）
 * - 正式：SameSite=None  Secure（必須 HTTPS），以支援跨網域前端
 */
function buildCookieOptions(maxAgeSec = 7 * 24 * 60 * 60) {
  return {
    httpOnly: true,
    path: "/",
    maxAge: maxAgeSec, // 單位：秒
    sameSite: IS_PROD ? "none" : "lax",
    secure: IS_PROD,
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
              u.token_version,
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
      {
        id: user.id,
        username: user.username,
        role: user.role_code,
        tv: user.token_version ?? 0, //修改密碼時判斷舊 token 是否失效
      },
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
  // 改用共用函式清除 Cookie（maxAge=0）
  res.setHeader(
    "Set-Cookie",
    cookie.serialize("auth", "", { ...buildCookieOptions(0), maxAge: 0 })
  );
  res.json({ ok: true });
});

/** 目前登入者資訊（由 JWT 解析來） */
router.get("/me", async (req, res) => {
  const c = req.headers.cookie ? cookie.parse(req.headers.cookie) : {};
  const token = c.auth;
  if (!token) return res.status(200).json({ ok: true, data: null });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query(
      `SELECT u.id, u.username, r.code AS role_code
        FROM "user" u
        JOIN user_role r ON r.id = u.role_id
        WHERE u.id = $1
        LIMIT 1`,
      [payload.id]
    );
    const u = rows[0];
    if (!u) return res.status(200).json({ ok: true, data: null });

    return res.json({
      ok: true,
      data: { id: String(u.id), username: u.username, role: u.role_code },
    });
  } catch {
    return res.status(200).json({ ok: true, data: null });
  }
});


/** 修改密碼 */
router.post("/change-password", requireAuth, async (req, res) => {
  try {
    const { current_password, new_password, confirm_password } = req.body || {};
    if (!current_password || !new_password || !confirm_password) {
      return res.status(400).json({ ok: false, msg: "缺少必要欄位" });
    }
    if (new_password !== confirm_password) {
      return res.status(400).json({ ok: false, msg: "新密碼與確認新密碼不一致" });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ ok: false, msg: "密碼至少需 6 碼" });
    }
    // 若要強制 6 碼中必須含至少一個數字與一個英文字母，可改成下列這行：
    // if (!/(?=.*[A-Za-z])(?=.*\d).{6,}/.test(new_password)) return res.status(400).json({ ok:false, msg:"密碼需至少6碼，且包含英文字母與數字" });

    const uid = req.user.id;

    // 取得使用者資料
    const { rows } = await pool.query(
      `SELECT id, username, role_id, password, token_version
        FROM "user"
        WHERE id = $1
        LIMIT 1`,
      [uid]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, msg: "使用者不存在" });
    }
    const user = rows[0];

    // 驗證舊密碼是否正確
    const match = await bcrypt.compare(current_password, user.password);
    if (!match) {
      return res.status(400).json({ ok: false, msg: "目前密碼不正確" });
    }

    // 禁止新密碼與舊密碼相同
    const same = await bcrypt.compare(new_password, user.password);
    if (same) {
      return res.status(400).json({ ok: false, msg: "新密碼不得與舊密碼相同" });
    }

    // 雜湊新密碼
    const rounds = Number(process.env.BCRYPT_ROUNDS || 12);
    const newHash = await bcrypt.hash(new_password, rounds);

    // 更新密碼與 token_version（使舊 token 全部失效）
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const upd = await client.query(
        `UPDATE "user"
            SET password = $1,
                token_version = COALESCE(token_version, 0) + 1,
                updated_at = NOW()
          WHERE id = $2
        RETURNING id, username, role_id, token_version`,
        [newHash, uid]
      );
      await client.query("COMMIT");

      const updated = upd.rows[0];


      // 取 role_code
      const roleRow = await pool.query(
        `SELECT code FROM user_role WHERE id = $1 LIMIT 1`,
        [updated.role_id]
      );
      const roleCode = roleRow.rows[0]?.code || 'member';

      // 簽發 JWT，放在 HttpOnly Cookie）
      const payload = {
        id: updated.id,
        username: updated.username,
        role: roleCode,           // 用代碼（'admin' / 'member'）
        tv: Number(updated.token_version), // 一律用 DB 的 token_version
      };
      const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });

      // 更新 Cookie
      res.setHeader(
        "Set-Cookie",
        cookie.serialize("auth", token, buildCookieOptions(7 * 24 * 60 * 60))
      );

      return res.json({ ok: true, msg: "密碼已更新，其他裝置已登出" });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[change-password] error:", err);
    return res.status(500).json({ ok: false, msg: "伺服器錯誤" });
  }
});




// 健康檢查：確認這支路由有掛上（實際路徑 /api/auth/auth-ping）
router.get("/auth-ping", (_req, res) => {
  console.log("[auth] /auth-ping hit");
  res.json({ ok: true });
});


module.exports = router;
