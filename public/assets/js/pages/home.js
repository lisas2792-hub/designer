// ======================================================
//  home.js v2025-12-18-stable
//  同頁三區塊切換 + URL 分離：/projects /reminders /password
//  - 不重整頁面，靠 History API
//  - 支援：直接輸入網址 / 重整 / Back Forward
//  - 離開專案前 dirty 確認（策略 B：仍然離開=放棄修改）
// ======================================================

import { api } from "../api.js";
import { initPasswordFeature } from "./password.js";

async function loadProjectsFeature() {
  const v = encodeURIComponent(window.__BUILD_ID__ || "");
  // projects.js URL 每次部署都變，必定重抓，不受 30d immutable 影響
  const mod = await import(`./projects.js?v=${v}`);
  return mod;
}

window.__ME__ = null;

let passwordController = null;
let projectsController = null;

let currentViewKey = "projects";
let suppressNextPop = false;

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

function resolveViewKeyFromPath(pathname) {
  const p = (pathname || "/").replace(/\/+$/, "") || "/";

  if (p === "/projects") return "projects";
  if (p === "/reminders") return "reminders";
  if (p === "/password") return "password";

  if (p === "/home.html" || p === "/home") return "projects";
  return "projects";
}

// ------------------------------------------------------
// Dirty 保護：離開 projects 前確認（策略 B）
// - 使用者按「仍然離開」：放棄修改（清 dirty + 重新載入）
// ------------------------------------------------------
async function confirmLeaveProjectsIfNeeded(nextKey) {
  if (currentViewKey !== "projects") return true;
  if (nextKey === "projects") return true;

  if (projectsController && typeof projectsController.confirmNavigateWhenDirty === "function") {
    const ok = await projectsController.confirmNavigateWhenDirty();
    if (!ok) return false;

    // ✅ 仍然離開：你要的「歸 0 + 消除警示 + 回到乾淨狀態」
    if (typeof projectsController.discardUnsavedChanges === "function") {
      await projectsController.discardUnsavedChanges({ refresh: true });
    }
  }
  return true;
}

function applyView(key) {
  const safeKey = views[key] ? key : "projects";
  currentViewKey = safeKey;

  document.querySelectorAll(".nav button").forEach((b) => b.classList.remove("active"));
  const activeBtn = document.querySelector(`.nav button[data-view="${safeKey}"]`);
  if (activeBtn) activeBtn.classList.add("active");

  Object.values(views).forEach((v) => (v.style.display = "none"));
  views[safeKey].style.display = "";

  const titleEl = document.getElementById("pageTitle");
  if (titleEl) titleEl.textContent = titleMap[safeKey] || "";

  if (safeKey === "password" && passwordController && typeof passwordController.reset === "function") {
    passwordController.reset();
  }

  window.dispatchEvent(new CustomEvent("app:viewchange", { detail: { view: safeKey } }));
}

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
// Boot
// ------------------------------------------------------
(async function boot() {
  try {
    const me = await api.auth.me();
    if (!me) throw new Error("未取得使用者資訊");

    window.__ME__ = me;

    document.getElementById("accountName").textContent = me.username || me.name || "—";

    const roleCode = (me.role_code || me.role || "").toString().trim();
    const roleLabel = me.role_label || (roleCode === "admin" ? "系統管理員" : roleCode ? "一般會員" : "—");

    document.getElementById("accountRole").textContent = roleLabel;
  } catch (err) {
    console.error("[boot] me failed:", err);
    window.location.href = "/login.html";
    return;
  }

  try {
    const { initProjectsFeature } = await loadProjectsFeature();
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

  const initialKey = resolveViewKeyFromPath(location.pathname);
  await navigateToView(initialKey, { replace: true });
})();

// Sidebar click
document.querySelectorAll(".nav button").forEach((btn) => {
  btn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    const key = btn.dataset.view;
    await navigateToView(key, { replace: false });
  });
});

// Back/Forward
window.addEventListener("popstate", async () => {
  if (suppressNextPop) return;

  const nextKey = resolveViewKeyFromPath(location.pathname);

  const ok = await confirmLeaveProjectsIfNeeded(nextKey);
  if (!ok) {
    suppressNextPop = true;
    history.pushState({ view: currentViewKey }, "", viewToPath[currentViewKey] || "/projects");
    suppressNextPop = false;
    return;
  }

  applyView(nextKey);
});

// 登出（尊重 dirty；仍然離開=放棄修改）
document.getElementById("logoutBtn").addEventListener("click", async (ev) => {
  ev.preventDefault();

  if (projectsController && typeof projectsController.confirmNavigateWhenDirty === "function") {
    const ok = await projectsController.confirmNavigateWhenDirty();
    if (!ok) return;

    if (typeof projectsController.discardUnsavedChanges === "function") {
      await projectsController.discardUnsavedChanges({ refresh: true });
    }
  }

  try {
    await api.auth.logout();
  } catch (err) {
    console.warn("logout 失敗但不阻擋前端導頁", err);
  }

  sessionStorage.clear();
  window.location.href = "/login.html";
});
