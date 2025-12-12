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

// stageupload
const stageUploadModule = require("./stageupload");
// (改掛載前綴)router.use("/", stageUploadModule.router);
router.use("/stageupload", stageUploadModule.router); 

// reminders
router.use("/reminders", require("./reminders"));

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
