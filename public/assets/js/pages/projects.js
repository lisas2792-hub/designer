// ======================================================
//  projects.js v2025-12-18-stable (no-jump)
//  - 修正切換 tab 上下跳：保持 scrollTop + 不重建表頭
//  - 維持舊行為：仍然離開 => 放棄修改(清 dirty) + 警示消失
// ======================================================

import { api, apiFetch } from "../api.js";

export function initProjectsFeature() {
  const stageClassMap = { waiting: "status-waiting", design: "status-design", build: "status-build" };
  const stageValueMap = { 0: "waiting", 1: "design", 2: "build" };

  const projectsById = new Map(); // key: DB id（字串）
  const dirty = new Map();        // key: DB id（字串）, val: patch
  let currentFilter = "ongoing";  // ongoing / all / done

  // ======================================================
  // Scroll 穩定器（消掉上下跳）
  // ======================================================
  function getMainScroller() {
    // 你現在是 <main class="main"> 在捲動
    return document.querySelector("main.main") || document.querySelector(".main") || document.scrollingElement;
  }

  async function withStableScroll(fn) {
    const scroller = getMainScroller();
    const prevTop = scroller ? scroller.scrollTop : 0;

    // 執行 DOM 大改動
    const r = await fn();

    // 下一幀再還原 scrollTop（避免 reflow 後再跳一下）
    if (scroller) {
      requestAnimationFrame(() => {
        scroller.scrollTop = prevTop;
      });
    }
    return r;
  }

  function upsertProjectIntoMap(p) {
    projectsById.set(String(p.id), p);
  }

  function hasUnsavedChanges() {
    return dirty && typeof dirty.size === "number" && dirty.size > 0;
  }

  function showUnsavedNotice() {
    const el = document.getElementById("unsavedNotice");
    if (!el) return;
    el.style.display = "block";
    el.classList.add("is-visible");
  }

  function hideUnsavedNotice() {
    const el = document.getElementById("unsavedNotice");
    if (!el) return;
    el.style.display = "none";
    el.classList.remove("is-visible");
  }

  function syncUnsavedUI() {
    if (hasUnsavedChanges()) showUnsavedNotice();
    else hideUnsavedNotice();
  }

  function markDirty(id, patch) {
    const key = String(id);
    const prev = dirty.get(key) || {};
    dirty.set(key, { ...prev, ...patch });
    syncUnsavedUI();
  }

  async function discardUnsavedChanges({ refresh = true } = {}) {
    try { dirty.clear(); } catch {}
    syncUnsavedUI();
    if (refresh) {
      try { await loadAndRenderProjects(); } catch {}
    }
  }

  // ------------------------------------------------------
  // SweetAlert：未儲存離開確認（仍然離開=放棄修改）
  // ------------------------------------------------------
  async function confirmNavigateWhenDirty() {
    if (!hasUnsavedChanges()) return true;

    const r = await Swal.fire({
      icon: "warning",
      title: "尚未儲存變更",
      html: "你剛剛有修改尚未按「儲存」。<br>確定要離開或切換嗎？",
      showCancelButton: true,
      confirmButtonText: "仍然離開",
      cancelButtonText: "先去儲存",
    });
    return r.isConfirmed;
  }

  // ======================================================
  // Grid Header：只初始化一次，不要每次切 tab 重建
  // ======================================================
  function initGridHeaderOnce() {
    const head = document.getElementById("gridHeader");
    if (!head) return;
    if (head.dataset.inited === "1") return;

    head.dataset.inited = "1";

    // 固定 3 + 8(task-head) + 3(action-head)
    // 你只想看到前 3 個；task-head 會被 CSS visibility:hidden
    head.innerHTML = `
      <div>階段</div>
      <div>編號</div>
      <div>案名</div>

      <div class="task-head"></div>
      <div class="task-head"></div>
      <div class="task-head"></div>
      <div class="task-head"></div>
      <div class="task-head"></div>
      <div class="task-head"></div>
      <div class="task-head"></div>
      <div class="task-head"></div>

      <div class="action-head"></div>
      <div class="action-head"></div>
      <div class="action-head"></div>
    `;
  }

  // ------------------------------------------------------
  // 載入並渲染
  // ------------------------------------------------------
  async function loadAndRenderProjects() {
    const grid = document.getElementById("projectsGrid");
    if (!grid) return;

    initGridHeaderOnce();

    grid.innerHTML = "";

    try {
      const data = await apiFetch("/api/projects", { method: "GET" });
      if (data?.ok === false) throw new Error(data?.message || "load failed");
      const rows = data?.data || data || [];

      projectsById.clear();

      for (const p of rows) {
        upsertProjectIntoMap(p);
        grid.appendChild(renderProjectRow(p));
      }
    } catch (e) {
      console.error("load projects failed:", e);
      grid.innerHTML = `<div style="padding:12px;color:#b91c1c">載入失敗：${e?.message || e}</div>`;
    }

    await withStableScroll(async () => {
      applyFilter();
    });

    syncUnsavedUI();
  }

  // ------------------------------------------------------
  // 產生一列
  // ------------------------------------------------------
  function renderProjectRow(p) {
    const currentStage = p.stage_code || stageValueMap[p.stage_id] || "waiting";

    const row = document.createElement("div");
    row.className = `project-row ${stageClassMap[currentStage] || ""}`;
    row.dataset.dbId = String(p.id);
    row.dataset.projectId = p.project_id;

    const isDone = p.stage_id === 3;
    if (isDone) row.classList.add("is-done");

    // sort keys
    {
      const u = p.updated_at || p.updatedAt || p.updated_at_ts || null;
      row.dataset.updatedAt = u ? new Date(u).toISOString() : "";
    }
    {
      const c = p.created_at || p.createdAt || null;
      row.dataset.createdAt = c ? new Date(c).toISOString() : "";
    }

    // 階段下拉
    const cellStage = document.createElement("div");
    cellStage.className = "cell-stage";

    const sel = document.createElement("select");
    sel.className = "stage-select";
    sel.innerHTML = `
      <option value="0">等待</option>
      <option value="1">設計</option>
      <option value="2">施工</option>
    `;
    sel.value = String(p.stage_id ?? 0);
    sel.disabled = isDone;

    // SweetAlert dialogs（只掛一次）
    if (!window.openStageMetaDialogRequired) {
      window.openStageMetaDialogRequired = async function ({ title, start_date = null, estimated_days = null } = {}) {
        const { isConfirmed, value } = await Swal.fire({
          title: title || "請填寫階段資訊",
          html: `
            <div style="text-align:left">
              <label style="display:block;margin:6px 0 4px">開始日期（必填）</label>
              <input id="swal-input-date" type="date" class="swal2-input" style="width:80%;box-sizing:border-box" value="${start_date ?? ""}">
              <label style="display:block;margin:10px 0 4px">工期天數（必填）</label>
              <input id="swal-input-days" type="number" min="1" step="1" placeholder="天數" class="swal2-input" style="width:80%;box-sizing:border-box" value="${estimated_days ?? ""}">
            </div>
          `,
          focusConfirm: false,
          showCancelButton: true,
          confirmButtonText: "確認",
          cancelButtonText: "取消",
          preConfirm: () => {
            const d = document.getElementById("swal-input-date").value;
            const daysStr = document.getElementById("swal-input-days").value.trim();
            if (!d) { Swal.showValidationMessage("請填寫「開始日期」"); return false; }
            if (daysStr === "") { Swal.showValidationMessage("請填寫「工期天數」"); return false; }
            const n = Number(daysStr);
            if (!Number.isFinite(n) || n <= 0) { Swal.showValidationMessage("「工期天數」必須 > 0 的整數"); return false; }
            return { start_date: d, estimated_days: n };
          },
        });
        return isConfirmed ? value : null;
      };
    }

    if (!window.confirmStageWithExisting) {
      window.confirmStageWithExisting = async function ({ title, start_date, estimated_days }) {
        const { isConfirmed, isDenied } = await Swal.fire({
          icon: "question",
          title: title || "確認階段資訊",
          html: `
            <div style="text-align:left">
              <div style="margin:6px 0"><strong>開始日期：</strong>${start_date}</div>
              <div style="margin:6px 0"><strong>工期天數：</strong>${estimated_days} 天</div>
            </div>
          `,
          showDenyButton: true,
          showCancelButton: true,
          confirmButtonText: "確認使用這些值",
          denyButtonText: "我要修改",
          cancelButtonText: "取消",
        });
        return { useExisting: isConfirmed, editInstead: isDenied };
      };
    }

    sel.addEventListener("change", async (e) => {
      const prevVal = Number(p.stage_id ?? 0);
      const newVal = Number(e.target.value);
      const newCode = stageValueMap[newVal] || "waiting";

      if (newVal !== 0) {
        if (p.start_date && p.estimated_days != null) {
          const { useExisting, editInstead } = await window.confirmStageWithExisting({
            title: newVal === 1 ? "切換到「設計」" : newVal === 2 ? "切換到「施工」" : "切換階段",
            start_date: p.start_date,
            estimated_days: p.estimated_days,
          });

          if (!useExisting && !editInstead) {
            sel.value = String(prevVal);
            return;
          }

          let start_date = p.start_date;
          let estimated_days = p.estimated_days;

          if (editInstead) {
            const got = await window.openStageMetaDialogRequired({ title: "修改階段資訊", start_date, estimated_days });
            if (!got) { sel.value = String(prevVal); return; }
            start_date = got.start_date;
            estimated_days = got.estimated_days;
          }

          row.classList.remove("status-waiting", "status-design", "status-build");
          row.classList.add(stageClassMap[newCode] || "");

          markDirty(p.id, { stage_id: newVal, start_date, estimated_days });

          p.stage_id = newVal;
          p.stage_code = newCode;
          p.start_date = start_date;
          p.estimated_days = estimated_days;
        } else {
          const got = await window.openStageMetaDialogRequired({
            title: newVal === 1 ? "設定「設計」階段" : newVal === 2 ? "設定「施工」階段" : "設定階段資訊",
            start_date: p.start_date ?? null,
            estimated_days: p.estimated_days ?? null,
          });
          if (!got) { sel.value = String(prevVal); return; }

          row.classList.remove("status-waiting", "status-design", "status-build");
          row.classList.add(stageClassMap[newCode] || "");

          markDirty(p.id, { stage_id: newVal, start_date: got.start_date, estimated_days: got.estimated_days });

          p.stage_id = newVal;
          p.stage_code = newCode;
          p.start_date = got.start_date;
          p.estimated_days = got.estimated_days;
        }
      } else {
        row.classList.remove("status-waiting", "status-design", "status-build");
        row.classList.add(stageClassMap["waiting"] || "");

        markDirty(p.id, { stage_id: 0 });

        p.stage_id = 0;
        p.stage_code = "waiting";
      }
    });

    cellStage.appendChild(sel);
    row.appendChild(cellStage);

    // 編號 & 案名
    const cellId = document.createElement("div");
    cellId.className = "cell-id";
    cellId.textContent = p.project_id;
    row.appendChild(cellId);

    const cellName = document.createElement("div");
    cellName.className = "cell-name";
    cellName.textContent = p.name;
    row.appendChild(cellName);

    // 8 個工作格
    const taskLabels = ["丈量", "案例分析", "平面放樣", "平面圖", "平面系統圖", "立面框體圖", "立面圖", "施工圖"];
    taskLabels.forEach((label, idx) => {
      const no = idx + 1;
      const c = document.createElement("div");
      c.className = "task-cell";
      c.dataset.stageNo = String(no);
      c.innerHTML = `<span>${label}</span>`;
      row.appendChild(c);
    });

    bindStageCellClicks(row, p);
    loadStageLights(p, row);

    // 動作按鈕
    const btnEdit = document.createElement("button");
    btnEdit.className = "action-btn js-action";
    btnEdit.dataset.action = "edit";
    btnEdit.dataset.dbId = String(p.id);
    btnEdit.title = "編輯";
    btnEdit.setAttribute("aria-label", "編輯");
    btnEdit.textContent = "✏️";
    row.appendChild(btnEdit);

    const btnDelete = document.createElement("button");
    btnDelete.className = "action-btn js-action";
    btnDelete.dataset.action = "delete";
    btnDelete.dataset.dbId = String(p.id);
    btnDelete.title = "刪除";
    btnDelete.setAttribute("aria-label", "刪除");
    btnDelete.textContent = "🗑️";
    row.appendChild(btnDelete);

    const btnDone = document.createElement("button");
    btnDone.className = "action-btn js-action action-done";
    btnDone.dataset.action = "done";
    btnDone.dataset.dbId = String(p.id);
    btnDone.title = "標記為已完成";
    btnDone.setAttribute("aria-label", "標記為已完成");
    btnDone.textContent = "✅";
    row.appendChild(btnDone);

    return row;
  }

  // ------------------------------------------------------
  // 階段燈號
  // ------------------------------------------------------
  async function loadStageLights(p, rowEl) {
    try {
      const json = await api.stagePlan.get(p.id);
      if (json && json.ok === false) return;

      const stages = json?.data?.stages || json?.stages || [];
      const cellByNo = {};

      rowEl.querySelectorAll(".task-cell").forEach((el) => {
        const n = Number(el.dataset.stageNo || 0);
        if (n >= 1 && n <= 8) cellByNo[n] = el;
        el.dataset.state = "";
      });

      stages.forEach((s) => {
        const cell = cellByNo[s.no];
        if (!cell) return;

        if (s.status === "green") cell.dataset.state = "done";
        else if (s.status === "red") cell.dataset.state = "danger";
        else if (s.status === "orange") cell.dataset.state = "warn";
        else cell.dataset.state = "";
      });
    } catch (e) {
      console.warn("[stage-plan] load failed for project", p.id, e);
    }
  }

  function bindStageCellClicks(rowEl, p) {
    rowEl.querySelectorAll(".task-cell").forEach((cell) => {
      cell.addEventListener("click", async () => {
        const no = Number(cell.dataset.stageNo || 0);
        if (!no) return;
        window.openStageUpload(p.project_id, no, cell);
      });
    });
  }

  // ------------------------------------------------------
  // Tab / Filter
  // ------------------------------------------------------
  function refreshStageCellsForCurrentTab() {
    const rows = document.querySelectorAll("#projectsGrid .project-row");
    rows.forEach((row) => {
      const stageCell = row.querySelector(".cell-stage");
      if (!stageCell) return;

      const isDoneRow = row.classList.contains("is-done");
      const shouldShowBadge = isDoneRow && (currentFilter === "all" || currentFilter === "done");

      if (shouldShowBadge) {
        if (!stageCell.dataset.origHtml) stageCell.dataset.origHtml = stageCell.innerHTML;
        stageCell.innerHTML = '<div class="badge-done">已完成</div>';
      } else {
        if (stageCell.dataset.origHtml) {
          stageCell.innerHTML = stageCell.dataset.origHtml;
          delete stageCell.dataset.origHtml;
        }
      }

      const sel = stageCell.querySelector("select");
      if (sel) sel.disabled = isDoneRow;
    });
  }

  function applyFilterCore() {
    const rows = document.querySelectorAll("#projectsGrid .project-row");

    rows.forEach((row) => {
      const done = row.classList.contains("is-done");

      if (currentFilter === "done") row.style.display = done ? "" : "none";
      else if (currentFilter === "ongoing") row.style.display = done ? "none" : "";
      else row.style.display = "";

      const btnDone = row.querySelector(".action-done");
      if (btnDone) btnDone.style.display = done ? "none" : "";
    });

    // ongoing 顯示 legend；done/all 隱藏但佔位（不跳）
    const legend = document.getElementById("legendBar");
    if (legend) legend.classList.toggle("is-hidden", currentFilter !== "ongoing");

    refreshStageCellsForCurrentTab();

    // done sort
    if (currentFilter === "done") {
      const grid = document.getElementById("projectsGrid");
      const doneRows = Array.from(grid.querySelectorAll(".project-row.is-done"));
      doneRows.sort((a, b) => (b.dataset.updatedAt || "").localeCompare(a.dataset.updatedAt || ""));
      doneRows.forEach((r) => grid.appendChild(r));
    }

    // all sort
    if (currentFilter === "all") {
      const grid = document.getElementById("projectsGrid");
      const allRows = Array.from(grid.querySelectorAll(".project-row"));
      allRows.sort((a, b) => (b.dataset.createdAt || "").localeCompare(a.dataset.createdAt || ""));
      allRows.forEach((r) => grid.appendChild(r));
    }
  }

  function applyFilter() {
    // 外層包「保持 scrollTop」，消掉跳動
    return withStableScroll(async () => {
      applyFilterCore();
    });
  }

  // Tabs click（仍然離開=放棄修改）
  document.addEventListener("click", async (e) => {
    const tab = e.target.closest("#view-projects .tabs-row .tab");
    if (!tab) return;

    const isActive = tab.getAttribute("aria-selected") === "true";
    if (isActive) return;

    if (hasUnsavedChanges()) {
      const ok = await confirmNavigateWhenDirty();
      if (!ok) return;

      // ✅ 舊行為：放棄修改、清零、警示消失
      await discardUnsavedChanges({ refresh: true });
    }

    document.querySelectorAll("#view-projects .tabs-row .tab").forEach((t) => t.setAttribute("aria-selected", "false"));
    tab.setAttribute("aria-selected", "true");
    currentFilter = tab.dataset.filter || "ongoing";
    await applyFilter();
  });

  // ------------------------------------------------------
  // 新增 / 編輯 Modal + 送出（你原本邏輯保留）
  // ------------------------------------------------------
  const addBtn = document.getElementById("addProjectBtn");
  const modal = document.getElementById("createModal");
  const closeBtn = document.getElementById("modalCloseBtn");

  async function loadResponsibleOptionsInto(selectEl, selectedId = "") {
    try {
      selectEl.innerHTML = '<option value="">（未指派）</option>';

      const json = await apiFetch("/api/responsible-user/options", { method: "GET" });
      const users = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];

      for (const u of users) {
        const opt = document.createElement("option");
        opt.value = String(u.id);
        opt.textContent = u.username || u.name || String(u.id);
        selectEl.appendChild(opt);
      }

      const target = selectedId == null ? "" : String(selectedId).trim();
      const match = Array.from(selectEl.options).find((o) => String(o.value).trim() === target);
      if (match) selectEl.value = match.value;
      else selectEl.selectedIndex = 0;

      const role = (window.__ME__?.role_code || window.__ME__?.role || "").toString().trim();
      selectEl.disabled = role !== "admin" && role !== "系統管理員";
    } catch (e) {
      console.warn("load responsible users failed", e);
      selectEl.innerHTML = '<option value="">（未指派）</option>';
      selectEl.selectedIndex = 0;
      selectEl.disabled = true;
    }
  }

  async function saveProject(body) {
    const isEdit = !!body.id;
    const path = isEdit ? `/api/projects/${body.id}` : "/api/projects";

    const data = await apiFetch(path, { method: isEdit ? "PATCH" : "POST", body });
    if (data?.ok === false) throw new Error(data.message || "失敗");

    alert(isEdit ? "已更新專案" : "已新增專案");
    await loadAndRenderProjects();
  }

  function updateDuePreview() {
    const s = document.getElementById("f_start_date").value;
    const d = parseInt(document.getElementById("f_estimated_days").value, 10);
    const el = document.getElementById("f_due_preview");

    if (s && Number.isInteger(d) && d > 0) {
      const [Y, M, D] = s.split("-").map((n) => parseInt(n, 10));
      const base = new Date(Y, M - 1, D);
      base.setHours(12, 0, 0, 0);
      base.setDate(base.getDate() + (d - 1));

      const y = base.getFullYear();
      const m = String(base.getMonth() + 1).padStart(2, "0");
      const day = String(base.getDate()).padStart(2, "0");
      el.textContent = `預計完工日：${y}-${m}-${day}`;
    } else {
      el.textContent = "預計完工日：—";
    }
  }

  async function openEditModal(p) {
    const titleEl = document.querySelector("#createModal .modal-title");
    const submitBtn = document.getElementById("f_submit");

    modal.dataset.mode = "edit";
    modal.dataset.editId = String(p.id);

    titleEl.textContent = "編輯專案";
    submitBtn.textContent = "更新";

    modal.style.display = "flex";

    const selRU = document.getElementById("f_responsible_user");
    await loadResponsibleOptionsInto(selRU, p.responsible_user_id == null ? "" : String(p.responsible_user_id));

    document.getElementById("f_project_id").value = p.project_id ?? "";
    document.getElementById("f_name").value = p.name ?? "";
    document.getElementById("f_stage").value = String(p.stage_id ?? 0);
    document.getElementById("f_start_date").value = p.start_date ?? "";
    document.getElementById("f_estimated_days").value = (p.estimated_days ?? "") === null ? "" : (p.estimated_days ?? "");

    updateDuePreview();
    document.getElementById("f_project_id").disabled = true;
  }

  if (addBtn && modal && closeBtn) {
    addBtn.addEventListener("click", async () => {
      modal.dataset.mode = "create";
      modal.dataset.editId = "";
      document.querySelector("#createModal .modal-title").textContent = "新增專案";
      document.getElementById("f_submit").textContent = "送出";

      modal.style.display = "flex";
      await loadResponsibleOptionsInto(document.getElementById("f_responsible_user"), "");

      ["f_project_id", "f_name", "f_start_date", "f_estimated_days"].forEach((id) => (document.getElementById(id).value = ""));
      document.getElementById("f_stage").value = "0";
      document.getElementById("f_responsible_user").value = "";
      updateDuePreview();

      document.getElementById("f_project_id").disabled = false;
    });

    function closeModal() {
      modal.style.display = "none";
      modal.dataset.mode = "create";
      modal.dataset.editId = "";
      document.getElementById("f_project_id").disabled = false;
    }

    closeBtn.addEventListener("click", closeModal);
    document.getElementById("f_cancel").addEventListener("click", closeModal);
    modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

    document.getElementById("f_start_date").addEventListener("change", updateDuePreview);
    document.getElementById("f_estimated_days").addEventListener("input", updateDuePreview);

    document.getElementById("f_submit").addEventListener("click", async () => {
      const mode = modal.dataset.mode || "create";
      const editId = modal.dataset.editId || null;

      const body = {
        project_id: document.getElementById("f_project_id").value.trim(),
        name: document.getElementById("f_name").value.trim(),
        stage_id: Number(document.getElementById("f_stage").value),
        start_date: document.getElementById("f_start_date").value || null,
        estimated_days: (() => {
          const v = document.getElementById("f_estimated_days").value;
          return v === "" ? null : Number(v);
        })(),
        responsible_user_id: (() => {
          const v = document.getElementById("f_responsible_user").value;
          return v === "" ? null : String(v);
        })(),
        creator_user_id: window.__ME__?.id ?? null,
        creator_user_name: window.__ME__?.name ?? window.__ME__?.username ?? null,
      };

      if (mode === "edit" && editId) body.id = Number(editId);

      if (!body.project_id || !body.name) {
        alert("請填寫：編號、案名");
        return;
      }

      try {
        await saveProject(body);
        closeModal();
      } catch (e) {
        console.error("[SAVE] failed", e);
        alert("操作失敗：" + (e?.message || e));
      }
    });
  }

  // ------------------------------------------------------
  // 列表上的 ✏️ 🗑️ ✅
  // ------------------------------------------------------
  const gridEl = document.getElementById("projectsGrid");
  if (gridEl) {
    gridEl.addEventListener("click", async (e) => {
      const btn = e.target.closest(".js-action");
      if (!btn) return;

      const action = btn.dataset.action;
      const idStr = btn.dataset.dbId;
      const p = projectsById.get(idStr);

      if (action === "edit") {
        if (!p) { alert("找不到資料"); return; }
        openEditModal(p);
        return;
      }

      if (action === "delete") {
        if (!p) { alert("找不到資料"); return; }
        const ok = confirm(`確定要刪除「${p.project_id}｜${p.name}」嗎？`);
        if (!ok) return;

        try {
          await apiFetch(`/api/projects/${idStr}`, { method: "DELETE" });
          btn.closest(".project-row")?.remove();
          projectsById.delete(idStr);
        } catch (err) {
          console.error("[DELETE] failed", err);
          alert("刪除失敗：" + (err?.message || err));
        }
        return;
      }

      if (action === "done") {
        if (!p) { alert("找不到資料"); return; }
        const ok = confirm(`要把「${p.project_id}｜${p.name}」標記為已完成嗎？`);
        if (!ok) return;

        try {
          const rowEl = btn.closest(".project-row");
          rowEl?.classList.add("is-done");
          rowEl.dataset.updatedAt = new Date().toISOString();

          apiFetch(`/api/projects/${idStr}`, { method: "PATCH", body: { stage_id: 3 } }).catch(() => {});
          await applyFilter();
          alert("已標記為已完成");
        } catch (err) {
          console.error("[DONE] failed", err);
          alert("操作失敗：" + (err?.message || err));
        }
        return;
      }
    });
  }

  // ------------------------------------------------------
  // 儲存批次更新
  // ------------------------------------------------------
  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      if (dirty.size === 0) {
        Swal.fire({ icon: "info", title: "沒有變更", timer: 800, showConfirmButton: false });
        syncUnsavedUI();
        return;
      }

      Swal.fire({ title: "更新中...", allowOutsideClick: false, didOpen: () => Swal.showLoading() });

      try {
        const jobs = Array.from(dirty.entries()).map(([id, patch]) =>
          apiFetch(`/api/projects/${id}`, { method: "PATCH", body: patch }).then(() => id)
        );

        const results = await Promise.allSettled(jobs);
        const successIds = results.filter((r) => r.status === "fulfilled").map((r) => r.value);

        for (const id of successIds) dirty.delete(id);

        Swal.close();

        if (successIds.length > 0) {
          Swal.fire({ icon: "success", title: `已更新 ${successIds.length} 筆`, timer: 1000, showConfirmButton: false });
        }

        await loadAndRenderProjects();
        syncUnsavedUI();
      } catch (e) {
        Swal.close();
        console.error(e);
        Swal.fire("錯誤", "更新時發生錯誤", "error");
        syncUnsavedUI();
      }
    });
  }

  // ------------------------------------------------------
  // 上傳對話框（只初始化一次）— 保留你原本
  // ------------------------------------------------------
  (function initUploadOnce() {
    if (window.__UPLOAD_WIRED__) return;
    window.__UPLOAD_WIRED__ = true;

    const uploadModal = document.getElementById("uploadModal");
    const uploadInput = document.getElementById("uploadInput");
    const chooseBtn = document.getElementById("chooseFileBtn");
    const cancelBtn = document.getElementById("cancelUploadBtn");
    const statusBox = document.getElementById("uploadStatus");
    const hintBox = document.getElementById("uploadHint");

    if (!uploadModal || !uploadInput || !chooseBtn || !cancelBtn || !statusBox || !hintBox) {
      console.warn("[projects] upload UI elements not found, skip initUploadOnce");
      return;
    }

    let current = { projectNo: null, stageNo: null, cellEl: null };

    window.openStageUpload = async function (projectNo, stageNo, cellEl) {
      current = { projectNo, stageNo, cellEl };
      hintBox.textContent = `案件編號：${projectNo}　階段：${stageNo}`;
      statusBox.innerHTML = "載入中…";
      uploadInput.value = "";
      uploadModal.style.display = "flex";

      try {
        const data = await apiFetch(`/api/projects/${projectNo}/stages/${stageNo}/last`, { method: "GET" });

        if (data?.ok && data.file) {
          const file = data.file;
          const thumb = file.thumbnail_link || file.file_url;
          const link = file.file_url;
          statusBox.innerHTML = `
            <div style="margin-bottom:8px;">最後上傳：</div>
            <a href="${link}" target="_blank" style="display:inline-block;border:1px solid #ccc;border-radius:8px;overflow:hidden;">
              <img src="${thumb}" style="width:100%;max-width:200px;display:block;">
            </a>
            <div style="font-size:13px;margin-top:6px;">點圖可開啟完整檔案</div>
          `;
        } else {
          statusBox.textContent = "目前沒有上傳記錄";
        }
      } catch (err) {
        console.warn("load last file failed", err);
        statusBox.textContent = "無法取得上次上傳資訊";
      }
    };

    function closeUpload() {
      uploadModal.style.display = "none";
      current = { projectNo: null, stageNo: null, cellEl: null };
    }

    chooseBtn.addEventListener("click", () => uploadInput.click());
    cancelBtn.addEventListener("click", () => closeUpload());

    uploadInput.addEventListener("change", async () => {
      if (!uploadInput.files || uploadInput.files.length === 0) return;

      statusBox.textContent = "上傳中…";
      try {
        const fd = new FormData();
        for (const f of uploadInput.files) fd.append("files", f);

        const data = await apiFetch(`/api/projects/${current.projectNo}/stages/${current.stageNo}/upload`, {
          method: "POST",
          body: fd,
          isMultipart: true,
        });

        if (!data.ok) throw new Error(data.error || "上傳失敗");

        if (current.cellEl) current.cellEl.dataset.state = "done";

        statusBox.textContent = `✅ 已上傳 ${data.files?.length || uploadInput.files.length} 個檔案`;
        setTimeout(() => closeUpload(), 700);
      } catch (err) {
        statusBox.textContent = `❌ 錯誤：${err.message || err}`;
      }
    });
  })();

  // 視窗關閉：未儲存提示
  window.addEventListener("beforeunload", (e) => {
    if (!hasUnsavedChanges()) return;
    e.preventDefault();
    e.returnValue = "";
  });

  // 初始化
  hideUnsavedNotice();
  loadAndRenderProjects();

  return {
    hasUnsavedChanges,
    confirmNavigateWhenDirty,
    discardUnsavedChanges,
    reload: loadAndRenderProjects,
  };
}
