// routes/index.js
"use strict";

const express = require("express");
const router = express.Router();

// 子路由（都會在 server.js 先經過 attachUser + requireAuth）
router.use("/users", require("./user"));
router.use("/me", require("./me"));
router.use("/projects", require("./projects"));
router.use("/responsible-user", require("./responsibleuser"));

// stageplan
router.use("/stageplan", require("./stageplan"));

// stageupload（私有端）
const stageUploadModule = require("./stageupload");
router.use("/", stageUploadModule.router);

// 健康檢查
router.get("/__ping", (_req, res) => {
  res.json({
    ok: true,
    mounts: [
      "/users",
      "/me",
      "/projects",
      "/responsible-user",
      "/stageplan",
      "(stageupload under /)"
    ]
  });
});

module.exports = router;
