// 只留健康檢查
const express = require("express");
const router  = express.Router();

router.get("/health", (_req, res) => {
  res.json({ ok: true, at: "/api/users/health" });
});

module.exports = router;