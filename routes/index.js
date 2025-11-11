// routes/index.js
// 需登入的私有 API 總入口（精簡版）
"use strict";

const express = require("express");
const router = express.Router();

// 子路由（都會在 server.js 先經過 attachUser + requireAuth）
router.use("/users",            require("./user"));            // -> /api/users/...
router.use("/me",               require("./me"));              // -> /api/me/...
router.use("/projects",         require("./projects"));        // -> /api/projects/...
router.use("/responsible-user", require("./responsibleuser")); // -> /api/responsible-user/...

// 新：stageplan 專用前綴（前端 home.html 已改用這組）
router.use("/stageplan", require("./stageplan"));             // -> /api/stageplan/**

// stageupload（私有端）：檔案上傳仍維持原路徑（吃案件編號 projectNo）
const { router: stageUploadRoutes } = require("./stageupload");
router.use("/", stageUploadRoutes); // 例如：/api/projects/:projectNo/stages/:stageNo/upload

// 健康檢查（可保留，方便巡檢；上線穩定後可註解）
router.get("/__ping", (_req, res) => {
  res.json({ ok: true, mounts: ["/users","/me","/projects","/responsible-user","/stageplan","(stageupload under /)"] });
});

module.exports = router;
