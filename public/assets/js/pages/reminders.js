// public/assets/js/pages/reminders.js
// 事務提醒（以人為單位）— 清單 + 新增 Modal + 從資料庫載入與顏色規則
//
// 規格：
// - 卡片固定大小（依你 CSS），每人最多顯示 3×3 = 9 條「案名」；若無案名顯示「其他」
// - 卡片標題下方顯示「未完成：X」= 該人 open 事務數（從 DB 算）
// - 新增寫入 DB（POST /api/reminders），載入用 GET /api/reminders?status=open
// - 顏色：預設橘色（warn）；若「已逾一半期限」→ 紅色（danger）
// - 期限天數必須 ≥ 1（沒有 0）
//
// 依賴：/assets/js/api.js（api、toUserMessage）與你現有的 CSS（app.css + reminders.css）

import { api, toUserMessage } from "../api.js";

const MAX_VISIBLE = 9; // 每人最多顯示 9 條

let loadedOnce = false;
let rendering = false;     // ✅ 防止重複並發載入
let cachedPersons = [];    // [{id, username, display_name, ...}]
let cachedReminders = [];  // 從 DB 載入的 open 事務列

/* ------------------ 共用小工具 ------------------ */
function esc(s) {
  return String(s ?? "").replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c] || "")
  );
}
function nowTs() { return Date.now(); }
function daysBetweenUTC(startIso, endMs = nowTs()) {
  // 以日期為單位計算（含當天算第 1 天）
  const t0 = new Date(startIso);
  const ms = Math.max(0, endMs - t0.getTime());
  return Math.floor(ms / 86400000) + 1;
}
function dangerState(dueDays, createdAtIso) {
  // 若已逾一半期限 → danger（紅）；否則 warn（橘）
  const d = Number(dueDays);
  if (!Number.isFinite(d) || d <= 0) return "warn";
  const elapsed = daysBetweenUTC(createdAtIso);
  return (elapsed >= Math.ceil(d / 2)) ? "danger" : "warn";
}
function isRemindersPath() {
  // ✅ 你現在走 URL：/reminders
  const p = (location.pathname || "").replace(/\/+$/, "");
  return p === "/reminders";
}
function ensureRemindersViewShown() {
  // ✅ 若直接進 /reminders，讓側欄按鈕「自己按一下」以切換視圖與標題
  // （home.js 已經綁 click handler）
  const btn = document.querySelector('.nav button[data-view="reminders"]');
  if (btn && !btn.classList.contains("active")) {
    btn.click();
  }
}

/* ------------------ 登入 ------------------ */
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

/* ------------------ 後端資料 ------------------ */
// 1) 人員清單（你已有 /api/reminders/persons；保留 fallback）
async function fetchPersons() {
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

// 2) 事務清單（僅 open）
async function fetchOpenReminders() {
  // 期待回傳格式：[{ id, title, content, assignee_id, due_days, status, created_at }]
  try {
    const url = "/api/reminders?status=open";
    const r = await fetch(url, { headers: { Accept: "application/json" }, credentials: "include" });
    const j = await r.json().catch(() => ({}));
    if (Array.isArray(j?.data)) return j.data;
    if (Array.isArray(j)) return j; // 寬容
  } catch (_) {}
  return [];
}

/* ------------------ 渲染 ------------------ */
function personCardHtml(p, openCount = 0) {
  const name = esc(p.username || p.display_name || `使用者${p.id ?? ""}`);
  return `
    <div class="person-card" data-id="${p.id}">
      <div class="header">
        <div class="name">${name}</div>
      </div>
      <div class="stats" style="margin-top:-4px; margin-bottom:8px;">
        <span class="stat">未完成：${openCount}</span>
      </div>

      <!-- 固定 3×3 的網格，不會把卡片撐高 -->
      <div class="affair-list" data-expanded="false"></div>

      <!-- 固定高度的一列，預留給「顯示更多」。即使沒有也保留高度，不會改變卡片總高度 -->
      <div class="affair-more-row">
        <button class="affair-more-btn" type="button">顯示更多</button>
      </div>
    </div>
  `;
}

/** 控制 3×3 顯示與「顯示更多」按鈕 */
function applyVisibleLimit(listEl, moreBtn) {
  const expanded = (listEl.dataset.expanded === "true");
  const items = Array.from(listEl.querySelectorAll(".affair-item"));
  const total = items.length;
  const overflow = Math.max(0, total - MAX_VISIBLE);

  items.forEach((el, idx) => {
    el.style.display = expanded ? "" : (idx < MAX_VISIBLE ? "" : "none");
  });

  // ★ 告訴 CSS：這張卡片是否有「更多」
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

  // 連動整張卡片高度（展開時卡片放大顯示全部；收合回 3×3）
  const card = listEl.closest(".person-card");
  if (card) card.classList.toggle("is-expanded", !expanded);

  applyVisibleLimit(listEl, moreBtn);
}

/** 直接在單格按鈕上套顏色（保留你的橘/紅） */
function paintAffairByState(btnEl, state /* 'warn' | 'danger' */) {
  btnEl.classList.remove("warn", "danger");
  btnEl.classList.add(state);
}

/** 新增一筆事務 DOM（整個格子就是按鈕） */
function addAffairDOM(list, _moreBtn, row) {
  const label = (row.title && row.title.trim()) ? row.title.trim() : "其他";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "affair-item";
  btn.dataset.id = row.id;
  btn.dataset.assigneeId = row.assignee_id;
  btn.dataset.title = row.title || "";
  btn.dataset.content = row.content || "";
  btn.dataset.dueDays = row.due_days || "";
  btn.dataset.createdAt = row.created_at || "";
  btn.textContent = label;

  const state = dangerState(row.due_days, row.created_at);
  paintAffairByState(btn, state);

  btn.addEventListener("click", () => {
    // TODO: 詳情頁或彈窗
    // location.href = `/reminders/${row.id}`;
  });

  list.appendChild(btn);
}

function groupByAssignee(openRows) {
  const map = new Map(); // id -> rows[]
  for (const r of openRows) {
    const k = String(r.assignee_id);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

async function renderReminders({ force = false } = {}) {
  if (rendering) return;
  if (loadedOnce && !force) return;

  rendering = true;

  const grid = document.getElementById("remindersGrid");
  if (!grid) { rendering = false; return; }

  grid.textContent = "載入中…";

  try {
    const [persons, openRows] = await Promise.all([
      fetchPersons(),
      fetchOpenReminders(),
    ]);

    cachedPersons = persons;
    cachedReminders = openRows;

    if (!persons.length) {
      grid.innerHTML = `<div class="empty">目前沒有可顯示的使用者</div>`;
      return;
    }

    const grouped = groupByAssignee(openRows);

    // 先畫人員卡片（把 open 計數帶入）
    grid.innerHTML = persons.map((p) => {
      const cnt = (grouped.get(String(p.id)) || []).length;
      return personCardHtml(p, cnt);
    }).join("");

    // 再把每個人的 open 事務依「建立時間 ASC」加到卡片（新增在最後面）
    for (const p of persons) {
      const rows = (grouped.get(String(p.id)) || []).slice()
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

      const card = grid.querySelector(`.person-card[data-id="${p.id}"]`);
      const list = card?.querySelector(".affair-list");
      const moreBtn = card?.querySelector(".affair-more-btn");
      if (!list || !moreBtn) continue;

      rows.forEach((row) => addAffairDOM(list, moreBtn, row));
      applyVisibleLimit(list, moreBtn);
    }

    wireListInteractions();
    loadedOnce = true;
  } catch (err) {
    console.error(err);
    grid.innerHTML = `<div class="error">${esc(toUserMessage(err, "無法載入事務提醒"))}</div>`;
  } finally {
    rendering = false;
  }
}

/* ------------------ 新增（Modal） ------------------ */
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

    const row = j?.data || j;

    // 立即插入到對應卡片並更新顯示
    const { card, list, moreBtn } = getCardEls(row.assignee_id);
    if (list && moreBtn) {
      addAffairDOM(list, moreBtn, row);
      applyVisibleLimit(list, moreBtn);

      const stat = card.querySelector(".stats .stat");
      if (stat) {
        const m = /未完成：(\d+)/.exec(stat.textContent || "");
        const old = m ? Number(m[1]) : 0;
        stat.textContent = `未完成：${old + 1}`;
      }
    }

    closeAffairModal();
  } catch (err) {
    console.error(err);
    alert(toUserMessage(err, "新增失敗，請稍後再試"));
  }
}

/* ------------------ 清單互動 ------------------ */
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

function wireListInteractions() {
  if (window.__AFFAIR_LIST_WIRED__) return;
  window.__AFFAIR_LIST_WIRED__ = true;

  document.addEventListener("click", (e) => {
    const more = e.target.closest(".affair-more-btn");
    if (more) {
      const card = more.closest(".person-card");
      const list = card?.querySelector(".affair-list");
      if (list) toggleExpand(list, more);
      return;
    }

    const rowBtn = e.target.closest(".affair-item");
    if (rowBtn) {
      // TODO: 詳情／導頁
      // location.href = `/reminders/${rowBtn.dataset.id}`;
    }
  });
}

/* ------------------ 卡片/清單存取 ------------------ */
function getCardEls(userId) {
  const grid = document.getElementById("remindersGrid");
  let card = grid.querySelector(`.person-card[data-id="${userId}"]`);
  if (!card) {
    const u = (cachedPersons || []).find((x) => String(x.id) === String(userId))
      || { id: userId, username: `user${userId}` };

    const wrapper = document.createElement("div");
    wrapper.innerHTML = personCardHtml(u, 0);
    card = wrapper.firstElementChild;
    grid.appendChild(card);
  }
  const list = card.querySelector(".affair-list");
  const moreBtn = card.querySelector(".affair-more-btn");
  return { card, list, moreBtn };
}

/* ------------------ 啟動入口（✅ 這段是關鍵修正） ------------------ */
async function activateRemindersIfNeeded({ force = false } = {}) {
  // 1) 直接進 /reminders（含 F5）→ 先讓視圖切過去（由 home.js 控制 display/active/title）
  if (isRemindersPath()) {
    ensureRemindersViewShown();
  }

  // 2) 若已經在 reminders 視圖（按鈕 active）或 path 是 /reminders → 載入
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

  // 若你之後 home.js 有 dispatch 這個事件，也支援（可有可無）
  window.addEventListener("app:viewchange", async (ev) => {
    if (ev?.detail?.view === "reminders") {
      await ensureLogin();
      await renderReminders({ force: true });
      wireAffairModal();
    }
  });

  // 支援瀏覽器上一頁/下一頁（若你未來用 pushState）
  window.addEventListener("popstate", async () => {
    await activateRemindersIfNeeded({ force: true });
  });
}

document.addEventListener("DOMContentLoaded", bindNavHook);
