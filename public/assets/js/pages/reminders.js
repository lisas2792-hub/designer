// public/assets/js/pages/reminders.js
// ============================================================================
// 事務提醒（以人為單位）— 總覽（3×3）+ 新增 Modal + 詳細頁（整頁橫向列表）
//
// 需求（你目前確認版）：
// [總覽 /reminders]
// - 每人卡片固定大小（依你的 CSS）
// - 每人最多顯示 3×3 = 9 條；無案名顯示「其他」
// - 顯示「未完成：X」
// - 點「帳號(看起來像原本文字，不像按鈕)」→ 進詳細頁 /reminders?user=<id>
//
// [詳細 /reminders?user=<id>]
// - 進去後「直接列整個頁面」，不包在 card、不要小小一塊
// - 每個事務一列（橫向）：案名 / 內容 / 截止日期 / 操作(編輯、完成)
// - 沒案名顯示：----
// - 頁首顯示 username（不抓 display_name）
// - 右側操作 icon 在最後一欄（像 projects 那種）
//
// 互動：
// - 點總覽格子 → SweetAlert2 詳情彈窗（可編輯/完成）
// - 詳細頁：點列本身 → 開彈窗；點「完成」可直接完成；點「編輯」開彈窗
//
// 依賴：
// - /assets/js/api.js（api、toUserMessage）
// - SweetAlert2：home.html 載入 <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
//
// 注意：
// - 詳細頁的排版「跑版」通常是因為缺少專用 CSS；本版會在 JS 中「注入一段 scoped CSS」
//   (只作用在 .rem-detail 容器內) 以避免影響你其他頁面與既有 reminders.css。
// ============================================================================

import { api, toUserMessage } from "../api.js";

const MAX_VISIBLE = 9; // 總覽每人最多顯示 9 條（3×3）

let loadedOnce = false;
let rendering = false;
let cachedPersons = [];     // 人員清單快取
let cachedReminders = [];   // open reminders 快取

// ----------------------------------------------------------------------------
// 安全 escape：避免 XSS
// ----------------------------------------------------------------------------
function esc(s) {
  return String(s ?? "").replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c] || "")
  );
}

// ----------------------------------------------------------------------------
// 日期/顏色計算
// ----------------------------------------------------------------------------
function nowTs() { return Date.now(); }

function daysBetweenUTC(startIso, endMs = nowTs()) {
  // 以日期為單位計算（含當天算第 1 天）
  const t0 = new Date(startIso);
  const ms = Math.max(0, endMs - t0.getTime());
  return Math.floor(ms / 86400000) + 1;
}

function dangerState(dueDays, createdAtIso) {
  // 已逾一半期限 → danger（紅）；否則 warn（橘）
  const d = Number(dueDays);
  if (!Number.isFinite(d) || d <= 0) return "warn";
  const elapsed = daysBetweenUTC(createdAtIso);
  return (elapsed >= Math.ceil(d / 2)) ? "danger" : "warn";
}

function formatYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function computeDeadlineYmd(createdAtIso, dueDays) {
  // 截止日 = created_at + (due_days - 1)，含當天算第 1 天
  const d = Number(dueDays);
  const days = (Number.isFinite(d) && d >= 1) ? d : 1;

  const base = createdAtIso ? new Date(createdAtIso) : new Date();
  const safeBase = Number.isNaN(base.getTime()) ? new Date() : base;

  safeBase.setDate(safeBase.getDate() + (days - 1));
  return formatYmd(safeBase);
}

// ----------------------------------------------------------------------------
// 路徑/導頁（不改 home.js，只用 query 參數切詳細模式）
// ----------------------------------------------------------------------------
function isRemindersPath() {
  const p = (location.pathname || "").replace(/\/+$/, "");
  return p === "/reminders";
}

function ensureRemindersViewShown() {
  // 直接進 /reminders 時，確保側欄 view 切到 reminders（home.js 管 active/display/title）
  const btn = document.querySelector('.nav button[data-view="reminders"]');
  if (btn && !btn.classList.contains("active")) btn.click();
}

function getDetailUserIdFromUrl() {
  try {
    const sp = new URLSearchParams(location.search || "");
    const v = (sp.get("user") || "").trim();
    return v ? v : null;
  } catch {
    return null;
  }
}

function goToUserDetail(userId) {
  const uid = String(userId || "").trim();
  if (!uid) return;
  history.pushState({ view: "reminders", user: uid }, "", `/reminders?user=${encodeURIComponent(uid)}`);
}

function goToOverview() {
  history.pushState({ view: "reminders" }, "", "/reminders");
}

// ----------------------------------------------------------------------------
// 後端 API：更新/完成
// ----------------------------------------------------------------------------
async function patchReminder(reminderId, payload) {
  const url = `/api/reminders/${encodeURIComponent(reminderId)}`;

  // 先 PATCH
  let r = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });

  // 後端若只支援 PUT：fallback
  if (r.status === 405 || r.status === 404) {
    r = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
  }

  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.ok === false) throw new Error(j?.error || j?.message || "更新失敗");
  return j?.data || j;
}

async function completeReminder(reminderId) {
  // 若你後端完成狀態不是 done（例如 closed），改這裡即可
  return await patchReminder(reminderId, { status: "done" });
}

// ----------------------------------------------------------------------------
// SweetAlert2 詳情彈窗：總覽格子與詳細列共用
// ----------------------------------------------------------------------------
function openAffairDetailPopup(rowEl) {
  const reminderId = rowEl.dataset.id;
  const isAdmin = (window.__ME__?.role === "admin");

  const title0 = String(rowEl.dataset.title || "").trim();
  const content0 = String(rowEl.dataset.content || "").trim();
  const createdAt0 = String(rowEl.dataset.createdAt || "").trim();
  const dueDays0 = rowEl.dataset.dueDays;

  const deadlineYmd = computeDeadlineYmd(createdAt0, dueDays0).replaceAll("-", "/");

  const ICON_EDIT = "✏️";
  const ICON_SAVE = "💾";
  const ICON_DONE = "✅";

  const html = `
    <div class="af-wrap">
      <div class="af-head">
        <div class="af-title">事務內容</div>
        <div class="af-actions">
          ${isAdmin ? `
            <button class="action-btn js-af-action" type="button" data-action="edit" title="編輯" aria-label="編輯">${ICON_EDIT}</button>
          ` : ""}
          <button class="action-btn js-af-action action-done" type="button" data-action="done" title="完成" aria-label="完成">${ICON_DONE}</button>
        </div>
      </div>

      <div class="af-grid">
        <div class="af-label ${title0 ? "" : "af-hidden"}" data-row="titleLabel">案名</div>
        <div class="${title0 ? "" : "af-hidden"}" data-row="titleField">
          <div class="af-box" data-view="title">${esc(title0)}</div>
          <input class="af-input af-hidden" data-edit="title" value="${esc(title0)}" />
        </div>

        <div class="af-label">內容</div>
        <div>
          <div class="af-box af-box--content" data-view="content">${esc(content0)}</div>
          <textarea class="af-textarea af-hidden" data-edit="content">${esc(content0)}</textarea>
        </div>
      </div>

      <div class="af-meta">
        <div class="af-deadline">截止日期：${esc(deadlineYmd)}</div>
      </div>

      <div class="af-foot">
        <button class="af-close" type="button" data-action="close">關閉</button>
      </div>
    </div>
  `;

  // SweetAlert2 未載入：降級
  if (typeof Swal === "undefined") {
    alert(`${title0 ? `案名：${title0}\n` : ""}內容：\n${content0}\n\n截止日期：${deadlineYmd}`);
    return;
  }

  Swal.fire({
    title: "",
    html,
    showConfirmButton: false,
    showCloseButton: false,
    focusConfirm: false,
    width: 720,
    didOpen: () => {
      const root = Swal.getHtmlContainer();
      if (!root) return;

      let editMode = false;

      const btnEdit  = root.querySelector('[data-action="edit"]');
      const btnDone  = root.querySelector('[data-action="done"]');
      const btnClose = root.querySelector('[data-action="close"]');

      const viewTitle   = root.querySelector('[data-view="title"]');
      const editTitle   = root.querySelector('[data-edit="title"]');
      const viewContent = root.querySelector('[data-view="content"]');
      const editContent = root.querySelector('[data-edit="content"]');

      const titleLabelRow = root.querySelector('[data-row="titleLabel"]');
      const titleFieldRow = root.querySelector('[data-row="titleField"]');

      function setEditMode(on) {
        editMode = on;

        // admin 編輯模式：就算原本沒案名，也顯示案名列讓他補
        if (titleLabelRow) titleLabelRow.classList.toggle("af-hidden", !on && !title0);
        if (titleFieldRow) titleFieldRow.classList.toggle("af-hidden", !on && !title0);

        if (viewTitle) viewTitle.classList.toggle("af-hidden", on);
        if (editTitle) editTitle.classList.toggle("af-hidden", !on);

        if (viewContent) viewContent.classList.toggle("af-hidden", on);
        if (editContent) editContent.classList.toggle("af-hidden", !on);

        if (btnEdit) {
          btnEdit.textContent = on ? ICON_SAVE : ICON_EDIT;
          btnEdit.title = on ? "儲存" : "編輯";
          btnEdit.setAttribute("aria-label", on ? "儲存" : "編輯");
        }
      }

      if (btnClose) btnClose.addEventListener("click", () => Swal.close());

      // 完成
      if (btnDone) {
        btnDone.addEventListener("click", async () => {
          const ok = await Swal.fire({
            title: "確認完成？",
            text: "完成後此事務會從未完成清單移除。",
            icon: "warning",
            showCancelButton: true,
            confirmButtonText: "完成",
            cancelButtonText: "取消",
          });
          if (!ok.isConfirmed) return;

          try {
            await completeReminder(reminderId);

            // 從畫面移除
            rowEl.remove();

            // 詳細頁未完成數（若存在）
            const cntEl = document.getElementById("detailOpenCount");
            if (cntEl) {
              const n = Number(cntEl.dataset.count || cntEl.textContent || 0);
              const nn = Math.max(0, (Number.isFinite(n) ? n : 0) - 1);
              cntEl.dataset.count = String(nn);
              cntEl.textContent = String(nn);
            }

            // 總覽卡片未完成數 / more（若存在）
            const card = document.querySelector(`.person-card[data-id="${rowEl.dataset.assigneeId}"]`);
            if (card) {
              const stat = card.querySelector(".stats .stat");
              const listInCard = card.querySelector(".affair-list");
              const moreBtn = card.querySelector(".affair-more-btn");
              if (stat) {
                const m = /未完成：(\d+)/.exec(stat.textContent || "");
                const old = m ? Number(m[1]) : 0;
                stat.textContent = `未完成：${Math.max(0, old - 1)}`;
              }
              if (listInCard && moreBtn) applyVisibleLimit(listInCard, moreBtn);
            }

            cachedReminders = (cachedReminders || []).filter(r => String(r.id) !== String(reminderId));
            Swal.close();
          } catch (err) {
            console.error(err);
            Swal.fire({ icon: "error", title: "完成失敗", text: String(err?.message || err) });
          }
        });
      }

      // 編輯（admin）
      if (btnEdit) {
        btnEdit.addEventListener("click", async () => {
          // 第一次點：進編輯
          if (!editMode) {
            setEditMode(true);
            editContent?.focus();
            return;
          }

          // 第二次點：儲存
          try {
            const newTitle = editTitle ? String(editTitle.value || "").trim() : "";
            const newContent = editContent ? String(editContent.value || "").trim() : "";

            if (!newContent) {
              Swal.fire({ icon: "warning", title: "請輸入內容", text: "內容不可為空。" });
              return;
            }

            await patchReminder(reminderId, { title: newTitle || null, content: newContent });

            // 更新彈窗顯示
            if (viewTitle) viewTitle.textContent = newTitle;
            if (viewContent) viewContent.textContent = newContent;

            // 更新 row dataset
            rowEl.dataset.title = newTitle;
            rowEl.dataset.content = newContent;

            // 更新總覽格子顯示字（案名或其他）
            if (rowEl.classList.contains("affair-item")) {
              rowEl.textContent = newTitle ? newTitle : "其他";
            }

            // 更新詳細列三欄（若是詳細列）
            if (rowEl.classList.contains("rem-detail-row")) {
              const tEl = rowEl.querySelector('[data-col="title"]');
              const cEl = rowEl.querySelector('[data-col="content"]');
              if (tEl) tEl.textContent = newTitle ? newTitle : "----";
              if (cEl) cEl.textContent = newContent;
            }

            // 快取同步（可選）
            const idx = (cachedReminders || []).findIndex(r => String(r.id) === String(reminderId));
            if (idx >= 0) cachedReminders[idx] = { ...cachedReminders[idx], title: newTitle, content: newContent };

            setEditMode(false);
          } catch (err) {
            console.error(err);
            Swal.fire({ icon: "error", title: "更新失敗", text: String(err?.message || err) });
          }
        });
      }
    },
  });
}

// ----------------------------------------------------------------------------
// 登入
// ----------------------------------------------------------------------------
async function ensureLogin() {
  try {
    const me = await api.auth.me();
    if (!me) throw new Error("NOT_LOGIN");

    const nm = document.getElementById("accountName");
    const rl = document.getElementById("accountRole");
    if (nm) nm.textContent = me.username;
    if (rl) rl.textContent = me.role === "admin" ? "系統管理員" : "一般使用者";

    window.__ME__ = me;
    return me;
  } catch {
    location.href = "/login.html";
    throw new Error("redirect");
  }
}

// ----------------------------------------------------------------------------
// 後端資料
// ----------------------------------------------------------------------------
async function fetchPersons() {
  // 你已有 /api/reminders/persons；保留 fallback
  try {
    const r = await fetch("/api/reminders/persons", {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    const ct = r.headers.get("content-type") || "";
    if (!r.ok || !ct.includes("application/json")) throw new Error("not-json");
    const j = await r.json();
    if (j?.ok && Array.isArray(j.data)) return j.data;
  } catch (_) {}

  // fallback options API
  for (const url of ["/api/responsible-user/options", "/api/responsibleuser/options"]) {
    try {
      const r2 = await fetch(url, { headers: { Accept: "application/json" }, credentials: "include" });
      const ct2 = r2.headers.get("content-type") || "";
      if (!r2.ok || !ct2.includes("application/json")) continue;
      const j2 = await r2.json();
      const arr = Array.isArray(j2?.data) ? j2.data : (Array.isArray(j2) ? j2 : []);
      if (arr.length) {
        return arr.map((u, i) => ({
          id: u.id ?? u.user_id ?? i + 1,
          username: u.username ?? u.name ?? `user${i + 1}`,
          display_name: u.name ?? u.username ?? `使用者${i + 1}`,
        }));
      }
    } catch (_) {}
  }
  return [];
}

async function fetchOpenReminders() {
  try {
    const r = await fetch("/api/reminders?status=open", {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    const j = await r.json().catch(() => ({}));
    if (Array.isArray(j?.data)) return j.data;
    if (Array.isArray(j)) return j;
  } catch (_) {}
  return [];
}

// ----------------------------------------------------------------------------
// 總覽渲染（維持你的 3×3 卡片）
// ----------------------------------------------------------------------------
function personCardHtml(p, openCount = 0) {
  // 你要求：名字看起來像原本文字，不像按鈕
  // 做法：用 <a> + style 取消底線/繼承顏色，但仍可點擊
  const username = esc(p.username || `user${p.id ?? ""}`);
  return `
    <div class="person-card" data-id="${p.id}">
      <div class="header">
        <a
          class="name person-link"
          href="/reminders?user=${encodeURIComponent(p.id)}"
          data-user-id="${p.id}"
          style="cursor:pointer; text-decoration:none; color:inherit;"
        >${username}</a>
      </div>

      <div class="stats" style="margin-top:-4px; margin-bottom:8px;">
        <span class="stat">未完成：${openCount}</span>
      </div>

      <div class="affair-list" data-expanded="false"></div>

      <div class="affair-more-row">
        <button class="affair-more-btn" type="button">顯示更多</button>
      </div>
    </div>
  `;
}

function applyVisibleLimit(listEl, moreBtn) {
  const expanded = (listEl.dataset.expanded === "true");
  const items = Array.from(listEl.querySelectorAll(".affair-item"));
  const total = items.length;
  const overflow = Math.max(0, total - MAX_VISIBLE);

  items.forEach((el, idx) => {
    el.style.display = expanded ? "" : (idx < MAX_VISIBLE ? "" : "none");
  });

  const card = listEl.closest(".person-card");
  if (card) card.classList.toggle("has-more", overflow > 0);

  if (overflow > 0) {
    moreBtn.style.display = "inline-flex";
    moreBtn.textContent = expanded ? "收起" : `顯示更多（+${overflow}）`;
  } else {
    moreBtn.style.display = "none";
  }
}

function toggleExpand(listEl, moreBtn) {
  const expanded = (listEl.dataset.expanded === "true");
  listEl.dataset.expanded = expanded ? "false" : "true";

  const card = listEl.closest(".person-card");
  if (card) card.classList.toggle("is-expanded", !expanded);

  applyVisibleLimit(listEl, moreBtn);
}

function paintAffairByState(btnEl, state) {
  btnEl.classList.remove("warn", "danger");
  btnEl.classList.add(state);
}

function addAffairDOM(list, row) {
  const label = (row.title && row.title.trim()) ? row.title.trim() : "其他";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "affair-item";

  // dataset：彈窗/完成/編輯共用
  btn.dataset.id = row.id;
  btn.dataset.assigneeId = row.assignee_id;
  btn.dataset.title = row.title || "";
  btn.dataset.content = row.content || "";
  btn.dataset.dueDays = row.due_days || "";
  btn.dataset.createdAt = row.created_at || "";

  btn.textContent = label;
  paintAffairByState(btn, dangerState(row.due_days, row.created_at));

  list.appendChild(btn);
}

function groupByAssignee(openRows) {
  const map = new Map();
  for (const r of openRows) {
    const k = String(r.assignee_id);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

// ----------------------------------------------------------------------------
// 詳細頁排版：為避免「跑版」，在 JS 內注入一段 scoped CSS（只作用於 .rem-detail）
// ----------------------------------------------------------------------------
function ensureDetailStylesInjected() {
  if (document.getElementById("remDetailStyles")) return;

  const style = document.createElement("style");
  style.id = "remDetailStyles";
  style.textContent = `
    /* ============================
     * Reminders Detail (scoped)
     * 只作用在 .rem-detail 容器內
     * ============================ */
    .rem-detail{
      width:100%;
    }

    .rem-detail__top{
      display:flex;
      align-items:flex-end;
      justify-content:space-between;
      gap:12px;
      margin: 6px 0 14px;
    }
    .rem-detail__title{
      font-size:22px;
      font-weight:900;
      line-height:1.1;
    }
    .rem-detail__meta{
      margin-top:6px;
      font-size:12px;
      color:#6b7280;
    }
    .rem-detail__back{
      cursor:pointer;
      text-decoration:none;
      color:inherit;
      font-weight:700;
      white-space:nowrap;
    }

    .rem-detail__table{
      width:100%;
      border:1px solid #e5e7eb;
      border-radius:12px;
      overflow:hidden;
      background:#fff;
    }

    .rem-detail__head,
    .rem-detail__row{
      display:grid;
      grid-template-columns: 200px 1fr 140px 96px; /* 案名 / 內容 / 截止 / 操作 */
      align-items:center;
      gap:0;
    }

    .rem-detail__head{
      padding:10px 12px;
      font-weight:900;
      font-size:13px;
      background:#f9fafb;
      border-bottom:1px solid #e5e7eb;
    }

    .rem-detail__body .rem-detail__row{
      padding:10px 12px;
      font-size:13px;
      border-bottom:1px solid #e5e7eb;
      cursor:pointer;
      user-select:none;
    }
    .rem-detail__body .rem-detail__row:hover{
      background:#f9fafb;
    }
    .rem-detail__body .rem-detail__row:last-child{
      border-bottom:none;
    }

    .rem-col--title{
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }
    .rem-col--content{
      overflow:hidden;
      text-overflow:ellipsis;
    }
    .rem-col--deadline{
      white-space:nowrap;
    }

    .rem-col--actions{
      display:flex;
      justify-content:flex-end;
      gap:10px;
    }

    /* 手機：縮欄寬，避免整頁炸裂 */
    @media (max-width: 720px){
      .rem-detail__head,
      .rem-detail__row{
        grid-template-columns: 140px 1fr 110px 80px;
      }
    }
    @media (max-width: 520px){
      /* 更小：把截止日期縮到 92px，操作縮到 72px */
      .rem-detail__head,
      .rem-detail__row{
        grid-template-columns: 120px 1fr 92px 72px;
      }
    }
  `;
  document.head.appendChild(style);
}

// ----------------------------------------------------------------------------
// 詳細頁渲染（整頁、橫向列、最後一欄 icon）
// ----------------------------------------------------------------------------
function renderUserDetail({ userId, persons, openRows }) {
  ensureDetailStylesInjected();

  const grid = document.getElementById("remindersGrid");
  if (!grid) return;

  const u = (persons || []).find((x) => String(x.id) === String(userId));
  if (!u) {
    grid.innerHTML = `<div class="error">找不到此使用者或你沒有權限查看。</div>`;
    return;
  }

  // 你要求：只用 username，不用 display_name
  const username = esc(u.username || `user${u.id}`);

  const rows = (openRows || [])
    .filter((r) => String(r.assignee_id) === String(userId))
    .slice()
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  const count = rows.length;
  const isAdmin = (window.__ME__?.role === "admin");

  // 操作 icon（符合你要「像專案那樣最後面」）
  const ICON_EDIT = "✏️";
  const ICON_DONE = "✅";

  // ✅ 不包 card，直接整頁內容
  grid.innerHTML = `
    <div class="rem-detail" data-user="${esc(userId)}">
      <div class="rem-detail__top">
        <div>
          <div class="rem-detail__title">${username}</div>
          <div class="rem-detail__meta">
            未完成：<span id="detailOpenCount" data-count="${count}">${count}</span>
          </div>
        </div>
        <a class="rem-detail__back" href="/reminders" id="backToRemindersOverview">← 回列表</a>
      </div>

      <div class="rem-detail__table">
        <div class="rem-detail__head">
          <div>案名</div>
          <div>內容</div>
          <div>截止日期</div>
        </div>
        <div class="rem-detail__body" id="remDetailBody"></div>
      </div>
    </div>
  `;

  // SPA back（不整頁重整）
  const back = document.getElementById("backToRemindersOverview");
  if (back) {
    back.addEventListener("click", (e) => {
      e.preventDefault();
      goToOverview();
      renderReminders({ force: true });
    });
  }

  const body = document.getElementById("remDetailBody");
  if (!body) return;

  for (const r of rows) {
    const title = (r.title && r.title.trim()) ? r.title.trim() : "";
    const content = String(r.content || "").trim();
    const deadline = computeDeadlineYmd(r.created_at, r.due_days).replaceAll("-", "/");

    const row = document.createElement("div");
    row.className = "rem-detail__row rem-detail-row"; // rem-detail-row：讓彈窗更新欄位用

    // dataset：彈窗/完成/編輯共用
    row.dataset.id = r.id;
    row.dataset.assigneeId = r.assignee_id;
    row.dataset.title = r.title || "";
    row.dataset.content = r.content || "";
    row.dataset.dueDays = r.due_days || "";
    row.dataset.createdAt = r.created_at || "";

    row.innerHTML = `
      <div class="rem-col--title" data-col="title">${esc(title ? title : "----")}</div>
      <div class="rem-col--content" data-col="content">${esc(content)}</div>
      <div class="rem-col--deadline" data-col="deadline">${esc(deadline)}</div>
      <div class="rem-col--actions">
        ${isAdmin ? `
          <button type="button" class="action-btn rem-detail-edit" title="編輯" aria-label="編輯" data-action="edit">${ICON_EDIT}</button>
        ` : ""}
        <button type="button" class="action-btn rem-detail-done" title="完成" aria-label="完成" data-action="done">${ICON_DONE}</button>
      </div>
    `;

    body.appendChild(row);
  }
}

// ----------------------------------------------------------------------------
// 主渲染：依 URL 決定總覽或詳細
// ----------------------------------------------------------------------------
async function renderReminders({ force = false } = {}) {
  if (rendering) return;
  if (loadedOnce && !force) return;

  rendering = true;

  const grid = document.getElementById("remindersGrid");
  if (!grid) { rendering = false; return; }

  grid.textContent = "載入中…";

  try {
    const [persons, openRows] = await Promise.all([fetchPersons(), fetchOpenReminders()]);
    cachedPersons = persons;
    cachedReminders = openRows;

    if (!persons.length) {
      grid.innerHTML = `<div class="empty">目前沒有可顯示的使用者</div>`;
      return;
    }

    // 詳細模式
    const detailUserId = getDetailUserIdFromUrl();
    if (detailUserId) {
      renderUserDetail({ userId: detailUserId, persons, openRows });
      loadedOnce = true;
      return;
    }

    // 總覽模式
    const grouped = groupByAssignee(openRows);

    grid.innerHTML = persons.map((p) => {
      const cnt = (grouped.get(String(p.id)) || []).length;
      return personCardHtml(p, cnt);
    }).join("");

    for (const p of persons) {
      const rows = (grouped.get(String(p.id)) || []).slice()
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

      const card = grid.querySelector(`.person-card[data-id="${p.id}"]`);
      const list = card?.querySelector(".affair-list");
      const moreBtn = card?.querySelector(".affair-more-btn");
      if (!list || !moreBtn) continue;

      rows.forEach((row) => addAffairDOM(list, row));
      applyVisibleLimit(list, moreBtn);
    }

    loadedOnce = true;
  } catch (err) {
    console.error(err);
    grid.innerHTML = `<div class="error">${esc(toUserMessage(err, "無法載入事務提醒"))}</div>`;
  } finally {
    rendering = false;
  }
}

// ----------------------------------------------------------------------------
// 新增（Modal）
// ----------------------------------------------------------------------------
async function loadAssigneesInto(selectEl) {
  const arr = Array.isArray(cachedPersons) ? cachedPersons : [];
  selectEl.innerHTML =
    `<option value="" disabled selected>請選擇成員</option>` +
    arr.map((u) => `<option value="${u.id}">${esc(u.username || u.display_name || u.id)}</option>`).join("");
  selectEl.disabled = arr.length === 0;
}

function openAffairModal() {
  const m = document.getElementById("affairModal");
  if (!m) return;

  const titleEl = document.querySelector("#affairModal .modal-title");
  if (titleEl) titleEl.textContent = "新增事務";

  const t = document.getElementById("af_title");
  const c = document.getElementById("af_content");
  const s = document.getElementById("af_assignee");
  const d = document.getElementById("af_due");

  if (t) t.value = "";
  if (c) c.value = "";
  if (d) d.value = "";
  if (s) loadAssigneesInto(s);

  m.style.display = "flex";
}

function closeAffairModal() {
  const m = document.getElementById("affairModal");
  if (!m) return;
  m.style.display = "none";
}

async function submitAffair() {
  const title = (document.getElementById("af_title")?.value || "").trim();
  const content = (document.getElementById("af_content")?.value || "").trim();
  const assigneeId = document.getElementById("af_assignee")?.value;
  const dueDays = Number(document.getElementById("af_due")?.value);

  if (!assigneeId) { alert("請選擇指派對象"); return; }
  if (!Number.isInteger(dueDays) || dueDays <= 0) { alert("期限天數需為正整數且 ≥ 1"); return; }

  try {
    const body = {
      title: title || null,
      content: content || null,
      assignee_id: Number(assigneeId),
      due_days: dueDays,
      status: "open",
    };

    const r = await fetch("/api/reminders", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.ok === false) throw new Error(j?.error || j?.message || "新增失敗");

    // 最穩：重畫（避免排序/計數/顯示更多狀態不一致）
    await renderReminders({ force: true });
    closeAffairModal();
  } catch (err) {
    console.error(err);
    alert(toUserMessage(err, "新增失敗，請稍後再試"));
  }
}

// ----------------------------------------------------------------------------
// 綁定：Modal
// ----------------------------------------------------------------------------
function wireAffairModal() {
  if (window.__AFFAIR_WIRED__) return;
  window.__AFFAIR_WIRED__ = true;

  const openBtn = document.getElementById("addAffairBtn");
  const modal = document.getElementById("affairModal");
  const closeBtn = document.getElementById("affairCloseBtn");
  const cancelBtn = document.getElementById("af_cancel");
  const submitBtn = document.getElementById("af_submit");

  if (openBtn) openBtn.addEventListener("click", openAffairModal);
  if (closeBtn) closeBtn.addEventListener("click", closeAffairModal);
  if (cancelBtn) cancelBtn.addEventListener("click", closeAffairModal);

  if (modal) {
    modal.addEventListener("click", (e) => { if (e.target === modal) closeAffairModal(); });
  }
  if (submitBtn) submitBtn.addEventListener("click", submitAffair);
}

// ----------------------------------------------------------------------------
// 綁定：總覽/詳細互動（事件代理，一次綁定即可）
// ----------------------------------------------------------------------------
function wireListInteractions() {
  if (window.__AFFAIR_LIST_WIRED__) return;
  window.__AFFAIR_LIST_WIRED__ = true;

  document.addEventListener("click", async (e) => {
    // 1) 點帳號名 → 進詳細頁
    const personLink = e.target.closest(".person-link");
    if (personLink) {
      e.preventDefault();
      const uid = personLink.dataset.userId;
      if (uid) {
        goToUserDetail(uid);
        await renderReminders({ force: true });
      }
      return;
    }

    // 2) 總覽：顯示更多
    const more = e.target.closest(".affair-more-btn");
    if (more) {
      const card = more.closest(".person-card");
      const list = card?.querySelector(".affair-list");
      if (list) toggleExpand(list, more);
      return;
    }

    // 3) 總覽：點格子 → 彈窗
    const gridBtn = e.target.closest(".affair-item");
    if (gridBtn) {
      openAffairDetailPopup(gridBtn);
      return;
    }

    // 4) 詳細：點「完成」→ 直接完成（不開彈窗）
    const doneBtn = e.target.closest(".rem-detail-done");
    if (doneBtn) {
      e.preventDefault();
      e.stopPropagation();

      const row = doneBtn.closest(".rem-detail-row");
      if (!row) return;

      const reminderId = row.dataset.id;

      try {
        await completeReminder(reminderId);
        row.remove();

        // 更新未完成數
        const cntEl = document.getElementById("detailOpenCount");
        if (cntEl) {
          const n = Number(cntEl.dataset.count || cntEl.textContent || 0);
          const nn = Math.max(0, (Number.isFinite(n) ? n : 0) - 1);
          cntEl.dataset.count = String(nn);
          cntEl.textContent = String(nn);
        }

        cachedReminders = (cachedReminders || []).filter(r => String(r.id) !== String(reminderId));
      } catch (err) {
        console.error(err);
        alert(toUserMessage(err, "完成失敗"));
      }
      return;
    }

    // 5) 詳細：點「編輯」→ 開彈窗（由彈窗內做編輯儲存）
    const editBtn = e.target.closest(".rem-detail-edit");
    if (editBtn) {
      e.preventDefault();
      e.stopPropagation();

      const row = editBtn.closest(".rem-detail-row");
      if (row) openAffairDetailPopup(row);
      return;
    }

    // 6) 詳細：點列 → 開彈窗
    const detailRow = e.target.closest(".rem-detail-row");
    if (detailRow) {
      // 若點在操作欄內，不要再觸發列點擊
      if (e.target.closest(".rem-col--actions")) return;
      openAffairDetailPopup(detailRow);
      return;
    }
  });
}

// ----------------------------------------------------------------------------
// 啟動入口：讓 /reminders 直接可用（含 F5）
// ----------------------------------------------------------------------------
async function activateRemindersIfNeeded({ force = false } = {}) {
  if (isRemindersPath()) ensureRemindersViewShown();

  const activeBtn = document.querySelector('.nav button.active[data-view="reminders"]');
  if (isRemindersPath() || activeBtn) {
    await ensureLogin();
    await renderReminders({ force });
    wireAffairModal();
  }
}

function bindNavHook() {
  // 點側欄 reminders
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest('button[data-view="reminders"]');
    if (!btn) return;

    await ensureLogin();
    await renderReminders({ force: true });
    wireAffairModal();
  });

  // 直接進 /reminders 或 F5
  window.requestAnimationFrame(async () => {
    await activateRemindersIfNeeded({ force: true });
  });

  // 支援上一頁/下一頁（/reminders ↔ /reminders?user=...）
  window.addEventListener("popstate", async () => {
    await activateRemindersIfNeeded({ force: true });
  });
}

// ----------------------------------------------------------------------------
// 全域初始化（一次）
// ----------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  wireListInteractions(); // 只綁一次（事件代理）
  bindNavHook();
});
