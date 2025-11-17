// ======================================================
//  home.js v2025-11-17-split
//  主頁入口程式：只負責
//   - 取得登入者資訊 & 顯示名稱 / 角色
//   - 左側 nav 在「專案 / 修改密碼」之間切換
//   - 初始化：projects.js + password.js
// ======================================================

import { api } from "../api.js";                 // 只需要 api.auth.me / api.auth.logout
import { initPasswordFeature } from "./password.js"; // 密碼模組入口
import { initProjectsFeature } from "./projects.js";  // 專案模組入口

// ------------------------------------------------------
// 通用小工具
// ------------------------------------------------------

// 控制URL名稱 跟登入後的使用者名稱與顯示代表角色
function sanitize(s) {
  return String(s).replace(/[<>&"']/g, c => (
    { '<': '&lt;', '>': '&amp;', '>': '&gt;', '&': '&amp;', '"': '&quot;', '\'': '&#39;' }[c] || ''
  ));
}

// 取得目前使用者（從 ?username= 取）＊目前沒用到，先保留
function getCurrentUsername() {
  const params = new URLSearchParams(location.search);
  const u = params.get('username');
  return u;
}

// 保留目前登入者資訊（供建立專案用；projects.js 會讀取 window.__ME__）
window.__ME__ = null;

// 密碼功能控制器（由 password.js 回傳，可選擇提供 reset 等方法）
let passwordController = null;

// 專案功能控制器（由 projects.js 回傳：提供 hasUnsavedChanges / confirmNavigateWhenDirty / discardUnsavedChanges 等）
let projectsController = null;

// ------------------------------------------------------
// 開機：撈使用者 + 初始化專案/密碼功能
// ------------------------------------------------------
(async function boot() {
  try {
    // 統一走 api.auth.me()
    const me = await api.auth.me();
    if (!me) throw new Error("未取得使用者資訊");

    window.__ME__ = me;

    document.getElementById('accountName').textContent =
      me.username || me.name || '—';

    const roleCode  = (me.role_code || me.role || '').toString().trim();
    const roleLabel =
      me.role_label ||
      (roleCode === 'admin'
        ? '系統管理員'
        : (roleCode ? '一般會員' : '—'));

    document.getElementById('accountRole').textContent = roleLabel;

  } catch (err) {
    console.error("[boot] failed:", err);
    document.getElementById('accountName').textContent ||= '—';
    document.getElementById('accountRole').textContent ||= '—';
  }

  // ★ 初始化「專案模組」
  try {
    projectsController = initProjectsFeature();
  } catch (err) {
    console.error("[home] initProjectsFeature 失敗：", err);
  }

  // ★ 初始化「修改密碼模組」
  try {
    passwordController = initPasswordFeature({
      onSuccess() {
        console.log("[home] 密碼修改成功");
      },
    });
  } catch (err) {
    console.warn("[home] initPasswordFeature 失敗或尚未實作：", err);
  }
})();

// ------------------------------------------------------
// 左側 nav（專案 / 修改密碼）切換
// ------------------------------------------------------
const navButtons = document.querySelectorAll('.nav button');
const views = {
  projects: document.getElementById('view-projects'),
  password: document.getElementById('view-password'),
};
const titleMap = {
  projects: '所有專案進度',
  password: '修改密碼'
};

navButtons.forEach(btn => {
  btn.addEventListener('click', async () => {
    const key = btn.dataset.view;

    // 只有在切換「離開專案視圖」時，才需要確認未儲存
    if (key !== 'projects' && projectsController && typeof projectsController.confirmNavigateWhenDirty === 'function') {
      const ok = await projectsController.confirmNavigateWhenDirty();
      if (!ok) return;

      // 使用者選擇「仍要離開」→ 清掉未儲存 & 重新載入專案
      if (typeof projectsController.discardUnsavedChanges === 'function') {
        await projectsController.discardUnsavedChanges({ refresh: true });
      }
    }

    navButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    Object.values(views).forEach(v => v.style.display = 'none');
    views[key].style.display = '';
    document.getElementById('pageTitle').textContent = titleMap[key];

    // 切到密碼頁時，順便重置密碼表單
    if (key === 'password' && passwordController && typeof passwordController.reset === 'function') {
      passwordController.reset();
    }
  });
});

// ------------------------------------------------------
// 登出（登出前一樣尊重「未儲存」提醒）
// ------------------------------------------------------
document.getElementById("logoutBtn").addEventListener("click", async (ev) => {
  ev.preventDefault();

  if (projectsController && typeof projectsController.confirmNavigateWhenDirty === 'function') {
    const ok = await projectsController.confirmNavigateWhenDirty();
    if (!ok) return;
    // 登出直接整頁導走，就不需要 discardUnsavedChanges 了
  }

  try {
    await api.auth.logout();
  } catch (err) {
    console.warn("logout 失敗但不阻擋前端導頁", err);
  }

  sessionStorage.clear();
  window.location.href = "/login.html";
});
