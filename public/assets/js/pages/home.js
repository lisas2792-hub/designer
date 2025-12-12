// ======================================================
//  home.js v2025-12-12-routeviews-password
//  同頁三區塊切換 + URL 分離：/projects /reminders /password
//  - 不重整頁面，靠 History API
//  - 支援：直接輸入網址 / 重整 / Back Forward
//  - 保留：離開專案前 dirty 確認
// ======================================================

import { api } from "../api.js";
import { initPasswordFeature } from "./password.js";
import { initProjectsFeature } from "./projects.js";

// ------------------------------------------------------
// 全域狀態
// ------------------------------------------------------
window.__ME__ = null;

let passwordController = null;
let projectsController = null;

let currentViewKey = "projects";
let suppressNextPop = false;

// ------------------------------------------------------
// View / Title / Route 對照表
// ------------------------------------------------------
const views = {
  projects: document.getElementById("view-projects"),
  reminders: document.getElementById("view-reminders"),
  password: document.getElementById("view-password"),
};

const titleMap = {
  projects: "所有專案進度",
  reminders: "事務提醒",
  password: "修改密碼",
};

const viewToPath = {
  projects: "/projects",
  reminders: "/reminders",
  password: "/password",
};

// 允許舊入口（例如 /home.html）或未知路徑 fallback
function resolveViewKeyFromPath(pathname) {
  const p = (pathname || "/").replace(/\/+$/, "") || "/";

  if (p === "/projects") return "projects";
  if (p === "/reminders") return "reminders";
  if (p === "/password") return "password";

  // 舊入口
  if (p === "/home.html" || p === "/home") return "projects";

  // 其他未知：回 projects
  return "projects";
}

// ------------------------------------------------------
// Dirty 保護：離開 projects 前確認
// ------------------------------------------------------
async function confirmLeaveProjectsIfNeeded(nextKey) {
  if (currentViewKey !== "projects") return true;
  if (nextKey === "projects") return true;

  if (projectsController && typeof projectsController.confirmNavigateWhenDirty === "function") {
    const ok = await projectsController.confirmNavigateWhenDirty();
    if (!ok) return false;

    // 使用者仍要離開 → 清掉 dirty & 重新載入專案
    if (typeof projectsController.discardUnsavedChanges === "function") {
      await projectsController.discardUnsavedChanges({ refresh: true });
    }
  }

  return true;
}

// ------------------------------------------------------
// 套用 view 顯示（不處理 history）
// ------------------------------------------------------
function applyView(key) {
  const safeKey = views[key] ? key : "projects";
  currentViewKey = safeKey;

  // active 樣式
  document.querySelectorAll(".nav button").forEach((b) => b.classList.remove("active"));
  const activeBtn = document.querySelector(`.nav button[data-view="${safeKey}"]`);
  if (activeBtn) activeBtn.classList.add("active");

  // 顯示/隱藏
  Object.values(views).forEach((v) => (v.style.display = "none"));
  views[safeKey].style.display = "";

  // 標題
  const titleEl = document.getElementById("pageTitle");
  if (titleEl) titleEl.textContent = titleMap[safeKey] || "";

  // 切到 password 時重置表單
  if (safeKey === "password" && passwordController && typeof passwordController.reset === "function") {
    passwordController.reset();
  }

  // 給其他模組可選擇監聽（非必須）
  window.dispatchEvent(new CustomEvent("app:viewchange", { detail: { view: safeKey } }));
}

// ------------------------------------------------------
// 導航：切 view + pushState/replaceState
// ------------------------------------------------------
async function navigateToView(nextKey, { replace = false } = {}) {
  const key = views[nextKey] ? nextKey : "projects";

  const ok = await confirmLeaveProjectsIfNeeded(key);
  if (!ok) return;

  applyView(key);

  const targetPath = viewToPath[key] || "/projects";
  const state = { view: key };

  if (replace) history.replaceState(state, "", targetPath);
  else history.pushState(state, "", targetPath);
}

// ------------------------------------------------------
// Boot：撈登入者 + 初始化模組 + 依 URL 決定顯示區塊
// ------------------------------------------------------
(async function boot() {
  // ① 取得登入者
  try {
    const me = await api.auth.me();
    if (!me) throw new Error("未取得使用者資訊");

    window.__ME__ = me;

    document.getElementById("accountName").textContent = me.username || me.name || "—";

    const roleCode = (me.role_code || me.role || "").toString().trim();
    const roleLabel =
      me.role_label || (roleCode === "admin" ? "系統管理員" : roleCode ? "一般會員" : "—");

    document.getElementById("accountRole").textContent = roleLabel;
  } catch (err) {
    console.error("[boot] me failed:", err);
    window.location.href = "/login.html";
    return;
  }

  // ② 初始化模組
  try {
    projectsController = initProjectsFeature();
  } catch (err) {
    console.error("[home] initProjectsFeature 失敗：", err);
  }

  try {
    passwordController = initPasswordFeature({
      onSuccess() {
        console.log("[home] 密碼修改成功");
      },
    });
  } catch (err) {
    console.warn("[home] initPasswordFeature 失敗或尚未實作：", err);
  }

  // ③ 初始 view：依 URL（並把 /home.html 轉成 /projects）
  const initialKey = resolveViewKeyFromPath(location.pathname);
  await navigateToView(initialKey, { replace: true });
})();

// ------------------------------------------------------
// Sidebar 點擊：改為 URL 導航（pushState）
// ------------------------------------------------------
document.querySelectorAll(".nav button").forEach((btn) => {
  btn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    const key = btn.dataset.view;
    await navigateToView(key, { replace: false });
  });
});

// ------------------------------------------------------
// Back/Forward：依 URL 切換 view（popstate）
// ------------------------------------------------------
window.addEventListener("popstate", async () => {
  if (suppressNextPop) return;

  const nextKey = resolveViewKeyFromPath(location.pathname);

  const ok = await confirmLeaveProjectsIfNeeded(nextKey);
  if (!ok) {
    // 取消離開 → 把網址推回目前 view，避免停在錯誤 URL
    suppressNextPop = true;
    history.pushState({ view: currentViewKey }, "", viewToPath[currentViewKey] || "/projects");
    suppressNextPop = false;
    return;
  }

  applyView(nextKey);
});

// ------------------------------------------------------
// 登出（維持你原本的 dirty 尊重邏輯）
// ------------------------------------------------------
document.getElementById("logoutBtn").addEventListener("click", async (ev) => {
  ev.preventDefault();

  if (projectsController && typeof projectsController.confirmNavigateWhenDirty === "function") {
    const ok = await projectsController.confirmNavigateWhenDirty();
    if (!ok) return;
  }

  try {
    await api.auth.logout();
  } catch (err) {
    console.warn("logout 失敗但不阻擋前端導頁", err);
  }

  sessionStorage.clear();
  window.location.href = "/login.html";
});
