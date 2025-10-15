// /middleware/auth.js
const jwt = require("jsonwebtoken");
const cookie = require("cookie");
const { pool } = require("../db");
    
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_IN_PROD";

/** 從 Cookie 或 Authorization header 取出 JWT */
function extractToken(req) {
  if (req.headers.cookie) {
    try {
      const parsed = cookie.parse(req.headers.cookie);
      const keys = ["auth", "token", "jwt", "access_token"];
      for (const k of keys) {
        if (parsed?.[k]) return parsed[k];
      }
    } catch (_) {}
  }

  const raw = (req.headers.authorization || "").trim();
  if (raw) {
    const m = raw.match(/^Bearer\s+(.+)$/i); // 不分大小寫
    if (m && m[1]) return m[1].trim();
  }

  return null;
}

/** ✱ 新增：角色判斷工具（同時支援英文代碼與中文標籤） */
function isRole(userRole, ...targets) {
  const r = (userRole || "").toString().trim().toLowerCase();
  // 允許的等價表
  const aliases = {
    admin: new Set(["admin","系統管理員"]),
    member: new Set(["member","一般會員"]),
  };
  const ok = new Set();
  targets.forEach(t => {
    const key = (t || "").toString().trim().toLowerCase();
    if (aliases[key]) aliases[key].forEach(x => ok.add(x));
    ok.add(key);
  });
  // 同時比對中文與英文
  return ok.has(r) || ok.has(userRole);
}
function isAdmin(userRole) {
  return isRole(userRole, "admin");
}

/** 全域掛載：解析 JWT → （若含 tv）比對 DB 的 token_version → 注入 req.user */
async function attachUser(req, _res, next) {
  try {
    const token = extractToken(req);
    if (!token) return next();

    const p = jwt.verify(token, JWT_SECRET); // 可能含 p.tv（token_version）

    // 舊版 token：沒有 tv 就直接塞回（向下相容）
    if (typeof p.tv !== "number") {
      req.user = { id: p.id, username: p.username, role: p.role || null };
      return next();
    }

    // 新版 token：比對 DB 的 token_version
    const uid = Number(p.id); // 建議轉數字
    const { rows } = await pool.query(
      `
      SELECT
        u.id,
        u.username,
        u.role_id,
        u.token_version,
        ur.code AS role_code,   -- 例如 'admin'
        ur.name AS role_label   -- 中文欄位（例如 '系統管理員'）
      FROM "user" u
      LEFT JOIN user_role ur ON ur.id = u.role_id
      WHERE u.id = $1
      LIMIT 1
      `,
      [uid]
    );
    if (rows.length === 0) return next();

    const u = rows[0];

    // token_version 不一致 → 視為未登入
    if (Number(u.token_version) !== Number(p.tv)) {
      return next();
    }

    // 注入已驗證的使用者
    req.user = {
      id: u.id,
      username: u.username,
      role_id: u.role_id,
      role: u.role_code || null,        // 代碼（向下相容）
      role_code: u.role_code || null,   // 代碼
      role_label: u.role_label || null, // 中文（來自 user_role.name）
      token_version: Number(u.token_version),
    };
    return next();
  } catch (_) {
    // 壞 token / 驗證失敗 → 視為未登入
    return next();
  }
}


// 檢查版

// async function attachUser(req, _res, next) {
//   try {
//     // ① 先看瀏覽器到底有沒有送 Cookie
//     console.log('[attachUser] headers.cookie =', req.headers.cookie || null);

//     const token = extractToken(req);
//     console.log('[attachUser] extracted token?', !!token); // true/false
//     if (!token) return next();

//     let p;
//     try {
//       p = jwt.verify(token, JWT_SECRET);
//       console.log('[attachUser] jwt payload =', p); // 要看到 id / role / tv
//     } catch (e) {
//       console.warn('[attachUser] jwt.verify failed:', e?.message);
//       return next();
//     }

//     if (typeof p.tv !== 'number') {
//       req.user = { id: p.id, username: p.username, role: p.role || null };
//       return next();
//     }

//     let rows;
//     try {
//       ({ rows } = await pool.query(`
//         SELECT
//           u.id,
//           u.username,
//           u.role_id,
//           u.token_version,
//           ur.code AS role_code,   -- 角色代碼（admin/member）
//           ur.name AS role_label   -- 角色中文（系統管理員/一般會員）
//         FROM "user" u
//         LEFT JOIN user_role ur ON ur.id = u.role_id
//         WHERE u.id = $1
//         LIMIT 1
//       `, [p.id]));
//       console.log('[attachUser] db rows len =', rows?.length || 0, ' first =', rows && rows[0]);
//     } catch (e) {
//       console.warn('[attachUser] DB query failed:', e?.message);
//       return next();
//     }

//     const u = rows[0];
//     if (!u) return next();
//     if (Number(u.token_version) !== Number(p.tv)) {
//       console.warn('[attachUser] token_version mismatch', { db: u.token_version, token: p.tv });
//       return next();
//     }

//     req.user = {
//       id: u.id,
//       username: u.username,
//       role_id: u.role_id,
//       role: u.role_code || null,        // 代碼（向下相容）
//       role_code: u.role_code || null,   // 代碼
//       role_label: u.role_label || null, // 中文（來自 user_role.name）
//       token_version: Number(u.token_version),
//     };
//     return next();
//   } catch (e) {
//     console.warn('[attachUser] unexpected error', e?.message);
//     return next();
//   }
// }


/** 需登入 */
function requireAuth(req, res, next){
  if (!req.user) {
    return res.status(401).json({
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Unauthorized'
    });
  }
  next();
}

/** 需管理員 */
function requireAdmin(req, res, next) {
  if (!req.user?.id) {
    return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: 'Unauthorized' }); 
  }
  if (!isAdmin(req.user.role_code || req.user.role || req.user.role_label)) {
    return res.status(403).json({ ok: false, code: 'FORBIDDEN', message: 'Forbidden' });      
  }
  next();
}

/** 需特定角色之一：用法 requireRole("admin","manager") */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user?.id) {
      return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: 'Unauthorized' }); 
    }
    const ok = roles.some(r => isRole(req.user.role, r)); 
    if (!ok) {
      return res.status(403).json({ ok: false, code: 'FORBIDDEN', message: 'Forbidden' });       
    }
    next();
  };
}

module.exports = { attachUser, requireAuth, requireAdmin, requireRole };
