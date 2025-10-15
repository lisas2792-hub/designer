const { Router } = require("express");
const { pool } = require("../db");
const router = Router();

router.get("/me", async (req, res) => {
  try {
    const username = req.query.username;
    if (!username) return res.status(400).json({ ok:false, message:"missing username" });

    const sql = `
      SELECT u.id, u.username, u.name, r.name AS role_name
      FROM "user" u
      JOIN "user_role" r ON r.id = u.role_id
      WHERE u.username = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(sql, [username]);
    if (rows.length === 0) return res.status(404).json({ ok:false, message:"not found" });

    res.json({ ok:true, data: { 
      id: rows[0].id,
      username: rows[0].username,
      name: rows[0].name,
      role: rows[0].role_name
    }});

  } catch (e) {
    console.error("/api/me error", e);
    res.status(500).json({ ok:false, message:"server error" });
  }
});

module.exports = router;
