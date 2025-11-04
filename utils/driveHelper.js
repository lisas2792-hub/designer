// utils/driveHelper.js
"use strict";

const { google } = require("googleapis");
const path = require("node:path");
const fs = require("node:fs");

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const folderCache = new Map(); // 避免重複查詢

function esc(str = "") {
  return String(str).replace(/(['\\])/g, "\\$1");
}

function slug(s) {
  return String(s || "")
    .normalize("NFKC")
    .trim()
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

async function getDrive(scopes = ["https://www.googleapis.com/auth/drive.file"]) {
  const auth = await google.auth.getClient({ scopes });
  return google.drive({ version: "v3", auth });
}

async function findFolderId(drive, name, parentId) {
  const key = `${parentId || "root"}::${name}`;
  if (folderCache.has(key)) return folderCache.get(key);

  const q = [
    `mimeType='${DRIVE_FOLDER_MIME}'`,
    `name='${esc(name)}'`,
    "trashed=false",
    parentId ? `'${parentId}' in parents` : ""
  ].filter(Boolean).join(" and ");

  const { data } = await drive.files.list({
    q,
    fields: "files(id,name)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const found = data.files?.[0];
  if (found?.id) {
    folderCache.set(key, found.id);
    return found.id;
  }
  return null;
}

async function createFolder(drive, name, parentId, appProps) {
  const body = {
    name,
    mimeType: DRIVE_FOLDER_MIME,
    parents: parentId ? [parentId] : undefined,
    appProperties: appProps || undefined,
  };
  const { data } = await drive.files.create({
    requestBody: body,
    fields: "id,name",
    supportsAllDrives: true,
  });
  folderCache.set(`${parentId || "root"}::${name}`, data.id);
  return data.id;
}

async function ensureFolder(drive, name, parentId, appProps) {
  const id = await findFolderId(drive, name, parentId);
  if (id) return id;
  return createFolder(drive, name, parentId, appProps);
}

function loadStageNames() {
  const cfgPath = path.resolve(process.cwd(), "config", "stages.json");
  if (fs.existsSync(cfgPath)) {
    const arr = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (Array.isArray(arr) && arr.length > 0) return arr;
  }
  return ["丈量", "文庫", "案例分析", "平面放樣", "平面圖", "平面系統圖", "立面框體圖", "立面圖", "施工圖"];
}

async function ensureProjectWithStages(drive, { rootFolderId, projectName, projectId, stageNames }) {
  const safeProjectName = slug(projectName || projectId || "未命名專案");
  const projectFolderId = await ensureFolder(drive, safeProjectName, rootFolderId, {
    type: "project",
    projectId: String(projectId || ""),
  });

  const stageFolderIds = new Map();
  for (const stageName of stageNames) {
    const fid = await ensureFolder(drive, slug(stageName), projectFolderId, {
      type: "stage",
      stageName,
      projectId: String(projectId || ""),
    });
    stageFolderIds.set(stageName, fid);
  }

  return { projectFolderId, stageFolderIds };
}

async function ensureStageFolderId(drive, { rootFolderId, projectName, projectId, stageName }) {
  const { stageFolderIds } = await ensureProjectWithStages(drive, {
    rootFolderId,
    projectName,
    projectId,
    stageNames: [stageName],
  });
  return stageFolderIds.get(stageName);
}

module.exports = {
  getDrive,
  loadStageNames,
  ensureFolder,
  ensureProjectWithStages,
  ensureStageFolderId,
};
