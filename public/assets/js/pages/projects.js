// 專案清單邏輯// ======================================================
//  projects.js v2025-11-17
//  專案管理模組：負責
//   - 專案清單載入 / 渲染
//   - 階段切換 + SweetAlert 填日期/工期
//   - 未儲存變更 dirty 管理 + 提示條
//   - 新增 / 編輯 / 刪除 / 標記完成
//   - 進行中 / 全部 / 已完成 Tabs
//   - 各階段上傳對話框（含顯示最後上傳縮圖）
// ======================================================

import { api, apiFetch } from "../api.js";

/**
 * 初始化專案功能。
 * 
 * 回傳 controller 物件，給外部（home.js）使用：
 * - hasUnsavedChanges(): boolean
 * - confirmNavigateWhenDirty(): Promise<boolean>   // true 代表可以離開
 * - discardUnsavedChanges({ refresh }): Promise<void>
 */
export function initProjectsFeature() {
  // ------------------------------------------------------
  // 內部狀態與共用資料
  // ------------------------------------------------------

  // stage 對應 class 的 map（供列樣式使用）
  const stageClassMap = { waiting: 'status-waiting', design: 'status-design', build: 'status-build' };
  const stageValueMap = { 0: 'waiting', 1: 'design', 2: 'build' };

  // 目前列表資料快取（key: DB id）
  const projectsById = new Map();

  // 未儲存變更：key: project.id, val: 局部 patch 物件
  const dirty = new Map();

  // Tabs 狀態：ongoing / all / done
  let currentFilter = 'ongoing';

  function upsertProjectIntoMap(p) {
    projectsById.set(String(p.id), p);
  }

  function hasUnsavedChanges() {
    return dirty && typeof dirty.size === 'number' && dirty.size > 0;
  }

  function showUnsavedNotice() {
    const notice = document.getElementById('unsavedNotice');
    if (notice) {
      notice.style.display = 'block';
      notice.classList.add('is-visible');
    }
  }

  function hideUnsavedNotice() {
    const el = document.getElementById('unsavedNotice');
    if (el) { el.style.display = 'none'; el.classList.remove('is-visible'); }
  }

  function markDirty(id, patch) {
    const prev = dirty.get(id) || {};
    dirty.set(id, { ...prev, ...patch });
    showUnsavedNotice();
  }

  async function discardUnsavedChanges({ refresh = true } = {}) {
    try { dirty.clear(); } catch {}
    hideUnsavedNotice();
    if (refresh) {
      try { await loadAndRenderProjects(); } catch {}
    }
  }

  // ------------------------------------------------------
  // SweetAlert：未儲存離開確認
  // ------------------------------------------------------
  async function confirmNavigateWhenDirty() {
    if (!hasUnsavedChanges()) return true;

    const r = await Swal.fire({
      icon: 'warning',
      title: '尚未儲存變更',
      html: '你剛剛有修改尚未按「儲存」。<br>確定要離開或切換嗎？',
      showCancelButton: true,
      confirmButtonText: '仍然離開',
      cancelButtonText: '先去儲存',
    });
    return r.isConfirmed;
  }

  // ------------------------------------------------------
  // 從後端載入專案並渲染
  // ------------------------------------------------------
  async function loadAndRenderProjects() {
    const grid = document.getElementById('projectsGrid');
    if (!grid) return;
    grid.innerHTML = ""; // 先清空

    try {
      const data = await apiFetch("/api/projects", { method: "GET" });

      // 後端可能回 { ok, data: [...] } 或直接回陣列
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

    applyFilter();
  }

  // ------------------------------------------------------
  // 產生一列 DOM（含 8 個任務格）
  // ------------------------------------------------------
  function renderProjectRow(p) {
    const currentStage = (p.stage_code || stageValueMap[p.stage_id] || 'waiting');

    const row = document.createElement('div');
    row.className = `project-row mode-default ${stageClassMap[currentStage] || ''}`;
    row.dataset.dbId = String(p.id);        // 真正 DB id（之後 PATCH 用）
    row.dataset.projectId = p.project_id;   // 顯示的編號

    const isDone = p.stage_id === 3;
    if (isDone) row.classList.add('is-done');

    // updated_at → 供「已完成」分頁排序
    {
      const u = p.updated_at || p.updatedAt || p.updated_at_ts || null;
      if (u) {
        const iso = new Date(u).toISOString();
        if (!Number.isNaN(Date.parse(iso))) {
          row.dataset.updatedAt = iso;
        }
      } else {
        row.dataset.updatedAt = '';
      }
    }

    // created_at → 供「全部」分頁排序
    {
      const c = p.created_at || p.createdAt || null;
      if (c) {
        const iso = new Date(c).toISOString();
        if (!Number.isNaN(Date.parse(iso))) {
          row.dataset.createdAt = iso;
        }
      } else {
        row.dataset.createdAt = '';
      }
    }

    // --------- 階段下拉（未完成） ---------
    const cellStage = document.createElement('div');
    cellStage.className = 'cell-stage';

    const sel = document.createElement('select');
    sel.className = 'stage-select';
    sel.innerHTML = `
      <option value="0">等待</option>
      <option value="1">設計</option>
      <option value="2">施工</option>
    `;
    sel.value = String(p.stage_id ?? 0);
    sel.disabled = isDone;

    // ===== SweetAlert 視窗們（全域只掛一次，避免重複宣告） =====
    if (!window.openStageMetaDialogRequired) {
      window.openStageMetaDialogRequired = async function({ title, start_date = null, estimated_days = null } = {}) {
        const { isConfirmed, value } = await Swal.fire({
          title: title || '請填寫階段資訊',
          html: `
            <div style="text-align:left">
              <label style="display:block;margin:6px 0 4px">開始日期（必填）</label>
              <input id="swal-input-date" type="date" class="swal2-input" style="width:80%;box-sizing:border-box" value="${start_date ?? ''}">
              <label style="display:block;margin:10px 0 4px">工期天數（必填）</label>
              <input id="swal-input-days" type="number" min="1" step="1" placeholder="天數" class="swal2-input" style="width:80%;box-sizing:border-box" value="${estimated_days ?? ''}">
            </div>
          `,
          focusConfirm: false,
          showCancelButton: true,
          confirmButtonText: '確認',
          cancelButtonText: '取消',
          preConfirm: () => {
            const d = document.getElementById('swal-input-date').value;
            const daysStr = document.getElementById('swal-input-days').value.trim();
            if (!d) { Swal.showValidationMessage('請填寫「開始日期」'); return false; }
            if (daysStr === '') { Swal.showValidationMessage('請填寫「工期天數」'); return false; }
            const n = Number(daysStr);
            if (!Number.isFinite(n) || n <= 0) { Swal.showValidationMessage('「工期天數」必須 > 0 的整數'); return false; }
            return { start_date: d, estimated_days: n };
          }
        });
        return isConfirmed ? value : null;
      };
    }

    if (!window.confirmStageWithExisting) {
      window.confirmStageWithExisting = async function({ title, start_date, estimated_days }) {
        const { isConfirmed, isDenied } = await Swal.fire({
          icon: 'question',
          title: title || '確認階段資訊',
          html: `
            <div style="text-align:left">
              <div style="margin:6px 0"><strong>開始日期：</strong>${start_date}</div>
              <div style="margin:6px 0"><strong>工期天數：</strong>${estimated_days} 天</div>
            </div>
          `,
          showDenyButton: true,
          showCancelButton: true,
          confirmButtonText: '確認使用這些值',
          denyButtonText: '我要修改',
          cancelButtonText: '取消',
        });
        return { useExisting: isConfirmed, editInstead: isDenied };
      };
    }

    // ===== 下拉變更事件 =====
    sel.addEventListener('change', async (e) => {
      const prevVal = Number(p.stage_id ?? 0);
      const newVal  = Number(e.target.value);
      const newCode = stageValueMap[newVal] || 'waiting';

      if (newVal !== 0) {
        // 非等待：需要關注 start_date / estimated_days
        if (p.start_date && p.estimated_days != null) {
          const { useExisting, editInstead } = await window.confirmStageWithExisting({
            title: newVal === 1 ? '切換到「設計」' :
                    newVal === 2 ? '切換到「施工」' : '切換階段',
            start_date: p.start_date,
            estimated_days: p.estimated_days
          });

          if (!useExisting && !editInstead) {
            sel.value = String(prevVal);
            return;
          }

          let start_date     = p.start_date;
          let estimated_days = p.estimated_days;

          if (editInstead) {
            const got = await window.openStageMetaDialogRequired({
              title: '修改階段資訊',
              start_date,
              estimated_days
            });
            if (!got) {
              sel.value = String(prevVal);
              return;
            }
            start_date     = got.start_date;
            estimated_days = got.estimated_days;
          }

          row.classList.remove('status-waiting','status-design','status-build');
          row.classList.add(stageClassMap[newCode] || '');

          markDirty(p.id, { stage_id: newVal, start_date, estimated_days });

          p.stage_id       = newVal;
          p.stage          = newCode;
          p.stage_code     = newCode;
          p.start_date     = start_date;
          p.estimated_days = estimated_days;

        } else {
          // 沒有完整值 → 要求必填
          const got = await window.openStageMetaDialogRequired({
            title: newVal === 1 ? '設定「設計」階段' :
                    newVal === 2 ? '設定「施工」階段' : '設定階段資訊',
            start_date: p.start_date ?? null,
            estimated_days: p.estimated_days ?? null
          });
          if (!got) {
            sel.value = String(prevVal);
            return;
          }

          row.classList.remove('status-waiting','status-design','status-build');
          row.classList.add(stageClassMap[newCode] || '');

          markDirty(p.id, {
            stage_id: newVal,
            start_date: got.start_date,
            estimated_days: got.estimated_days
          });

          p.stage_id       = newVal;
          p.stage          = newCode;
          p.stage_code     = newCode;
          p.start_date     = got.start_date;
          p.estimated_days = got.estimated_days;
        }

      } else {
        // 等待：只更新階段，不動日期/天數
        row.classList.remove('status-waiting','status-design','status-build');
        row.classList.add(stageClassMap['waiting'] || '');

        markDirty(p.id, { stage_id: 0 });

        p.stage_id   = 0;
        p.stage      = 'waiting';
        p.stage_code = 'waiting';
      }
    });

    cellStage.appendChild(sel);
    row.appendChild(cellStage);

    // 編號 & 案名
    const cellId = document.createElement('div');
    cellId.className = 'cell-id';
    cellId.textContent = p.project_id;
    row.appendChild(cellId);

    const cellName = document.createElement('div');
    cellName.className = 'cell-name';
    cellName.textContent = p.name;
    row.appendChild(cellName);

    // 固定的 8 個工作格
    const taskLabels = ["丈量","案例分析","平面放樣","平面圖","平面系統圖","立面框體圖","立面圖","施工圖"];
    taskLabels.forEach((label, idx) => {
      const no = idx + 1;
      const c = document.createElement('div');
      c.className = 'task-cell';
      c.dataset.stageNo = String(no);
      c.innerHTML = `<span>${label}</span>`;
      row.appendChild(c);
    });

    bindStageCellClicks(row, p);
    loadStageLights(p, row);

    // 動作按鈕 （✏️ / 🗑️ / ✅）
    const btnEdit = document.createElement('button');
    btnEdit.className = 'action-btn js-action';
    btnEdit.dataset.action = 'edit';
    btnEdit.dataset.dbId   = String(p.id);
    btnEdit.title = '編輯';
    btnEdit.setAttribute('aria-label', '編輯');
    btnEdit.textContent = '✏️';
    row.appendChild(btnEdit);

    const btnDelete = document.createElement('button');
    btnDelete.className = 'action-btn js-action';
    btnDelete.dataset.action = 'delete';
    btnDelete.dataset.dbId = String(p.id);
    btnDelete.title = '刪除';
    btnDelete.setAttribute('aria-label', '刪除');
    btnDelete.textContent = '🗑️';
    row.appendChild(btnDelete);

    const btnDone = document.createElement('button');
    btnDone.className = 'action-btn js-action action-done';
    btnDone.dataset.action = 'done';
    btnDone.dataset.dbId   = String(p.id);
    btnDone.title = '標記為已完成';
    btnDone.setAttribute('aria-label', '標記為已完成');
    btnDone.textContent = '✅';
    row.appendChild(btnDone);

    return row;
  }

  // ------------------------------------------------------
  // 階段燈號（橘/紅/綠）載入 + 點格開上傳視窗
  // ------------------------------------------------------
  async function loadStageLights(p, rowEl) {
    try {
      const json = await api.stagePlan.get(p.id);
      if (json && json.ok === false) return;

      const stages = json?.data?.stages || json?.stages || [];
      const cellByNo = {};
      rowEl.querySelectorAll('.task-cell').forEach(el => {
        const n = Number(el.dataset.stageNo || 0);
        if (n >= 1 && n <= 8) cellByNo[n] = el;
        el.dataset.state = '';
      });

      stages.forEach(s => {
        const cell = cellByNo[s.no];
        if (!cell) return;
        if      (s.status === 'green')  cell.dataset.state = 'done';
        else if (s.status === 'red')    cell.dataset.state = 'danger';
        else if (s.status === 'orange') cell.dataset.state = 'warn';
        else                            cell.dataset.state = '';
      });
    } catch (e) {
      console.warn('[stage-plan] load failed for project', p.id, e);
    }
  }

  function bindStageCellClicks(rowEl, p) {
    rowEl.querySelectorAll('.task-cell').forEach(cell => {
      cell.addEventListener('click', async () => {
        const no = Number(cell.dataset.stageNo || 0);
        if (!no) return;
        window.openStageUpload(p.project_id, no, cell);
      });
    });
  }

  // ------------------------------------------------------
  // Tabs / 篩選 / 版型切換（進行中 / 全部 / 已完成）
  // ------------------------------------------------------
  function renderHeaderFor(filter) {
    const head = document.getElementById('gridHeader');
    if (!head) return;

    head.classList.remove('mode-done');
    head.classList.add('mode-default');

    head.innerHTML = `
      <div>階段</div>
      <div>編號</div>
      <div>案名</div>
      <div class="action-head"></div>
      <div class="action-head"></div>
      <div class="action-head"></div>
    `;
  }

  function switchRowLayoutFor(filter) {
    const rows = document.querySelectorAll('#projectsGrid .project-row');
    rows.forEach(r => {
      r.classList.add('mode-default');
      r.classList.remove('mode-done');
    });
  }

  function refreshStageCellsForCurrentTab() {
    const rows = document.querySelectorAll('#projectsGrid .project-row');
    rows.forEach(row => {
      const stageCell = row.querySelector('.cell-stage');
      if (!stageCell) return;

      const isDoneRow = row.classList.contains('is-done');
      const shouldShowBadge = isDoneRow && (currentFilter === 'all' || currentFilter === 'done');

      if (shouldShowBadge) {
        if (!stageCell.dataset.origHtml) {
          stageCell.dataset.origHtml = stageCell.innerHTML;
        }
        stageCell.innerHTML = '<div class="badge-done">已完成</div>';
      } else {
        if (stageCell.dataset.origHtml) {
          stageCell.innerHTML = stageCell.dataset.origHtml;
          delete stageCell.dataset.origHtml;
        }
      }

      const sel = stageCell.querySelector('select');
      if (sel) sel.disabled = isDoneRow;
    });
  }

  function applyFilter() {
    const rows = document.querySelectorAll('#projectsGrid .project-row');

    rows.forEach(row => {
      const done = row.classList.contains('is-done');

      if (currentFilter === 'done') {
        row.style.display = done ? '' : 'none';
      } else if (currentFilter === 'ongoing') {
        row.style.display = done ? 'none' : '';
      } else {
        row.style.display = '';
      }

      const btnDone = row.querySelector('.action-done');
      if (btnDone) {
        btnDone.style.display = done ? 'none' : '';
      }
    });

    const legend = document.getElementById('legendBar');
    if (legend) legend.style.display = (currentFilter === 'ongoing') ? '' : 'none';

    renderHeaderFor(currentFilter);
    switchRowLayoutFor(currentFilter);
    refreshStageCellsForCurrentTab();

    // 已完成：依 updated_at DESC
    if (currentFilter === 'done') {
      const grid = document.getElementById('projectsGrid');
      const rows = Array.from(grid.querySelectorAll('.project-row.is-done'));
      rows.sort((a, b) => {
        const ua = a.dataset.updatedAt || '';
        const ub = b.dataset.updatedAt || '';
        return ub.localeCompare(ua);
      });
      rows.forEach(r => grid.appendChild(r));
    }

    // 全部：依 created_at DESC
    if (currentFilter === 'all') {
      const grid = document.getElementById('projectsGrid');
      const rows = Array.from(grid.querySelectorAll('.project-row'));
      rows.sort((a, b) => {
        const ca = a.dataset.createdAt || '';
        const cb = b.dataset.createdAt || '';
        return cb.localeCompare(ca);
      });
      rows.forEach(r => grid.appendChild(r));
    }
  }

  // Tabs 點擊（進行中 / 全部 / 已完成）
  document.addEventListener('click', async (e) => {
    const tab = e.target.closest('.tabs-row .tab');
    if (!tab) return;

    const isActive = tab.getAttribute('aria-selected') === 'true';
    if (isActive) return;

    if (hasUnsavedChanges()) {
      const ok = await confirmNavigateWhenDirty();
      if (!ok) return;
      await discardUnsavedChanges({ refresh: true });
    }

    document.querySelectorAll('.tabs-row .tab').forEach(t => t.setAttribute('aria-selected','false'));
    tab.setAttribute('aria-selected','true');
    currentFilter = tab.dataset.filter || 'ongoing';
    applyFilter();
  });

  // ------------------------------------------------------
  // 新增 / 編輯 Modal + 送出
  // ------------------------------------------------------
  const addBtn  = document.getElementById('addProjectBtn');
  const modal   = document.getElementById('createModal');
  const closeBtn = document.getElementById('modalCloseBtn');

  async function loadResponsibleOptionsInto(selectEl, selectedId = '') {
    try {
      selectEl.innerHTML = '<option value="">（未指派）</option>';

      const json = await apiFetch("/api/responsible-user/options", { method: "GET" });
      const users = Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []);

      for (const u of users) {
        const opt = document.createElement('option');
        opt.value = String(u.id);
        opt.textContent = u.name || u.username || String(u.id);
        selectEl.appendChild(opt);
      }

      const target = (selectedId === null || selectedId === undefined) ? '' : String(selectedId).trim();
      const match  = Array.from(selectEl.options).find(o => String(o.value).trim() === target);

      if (match) {
        selectEl.value = match.value;
      } else {
        selectEl.selectedIndex = 0;
      }

      const role = (window.__ME__?.role_code || window.__ME__?.role || '').toString().trim();
      selectEl.disabled = (role !== 'admin' && role !== '系統管理員');

    } catch (e) {
      console.warn('load responsible users failed', e);
      selectEl.innerHTML = '<option value="">（未指派）</option>';
      selectEl.selectedIndex = 0;
      selectEl.disabled = true;
    }
  }

  async function saveProject(body) {
    const isEdit = !!body.id;
    const path = isEdit ? `/api/projects/${body.id}` : "/api/projects";

    const data = await apiFetch(path, {
      method: isEdit ? 'PATCH' : 'POST',
      body,
    });

    if (data?.ok === false) {
      throw new Error(data.message || "失敗");
    }

    alert(isEdit ? "已更新專案" : "已新增專案");
    await loadAndRenderProjects();
  }

  function updateDuePreview() {
    const s = document.getElementById('f_start_date').value;
    const d = parseInt(document.getElementById('f_estimated_days').value, 10);
    const el = document.getElementById('f_due_preview');

    if (s && Number.isInteger(d) && d > 0) {
      const [Y, M, D] = s.split('-').map(n => parseInt(n, 10));
      const base = new Date(Y, M - 1, D);
      base.setHours(12, 0, 0, 0);
      base.setDate(base.getDate() + (d - 1));

      const y = base.getFullYear();
      const m = String(base.getMonth() + 1).padStart(2, '0');
      const day = String(base.getDate()).padStart(2, '0');
      el.textContent = `預計完工日：${y}-${m}-${day}`;
    } else {
      el.textContent = '預計完工日：—';
    }
  }

  async function openEditModal(p) {
    const titleEl   = document.querySelector('#createModal .modal-title');
    const submitBtn = document.getElementById('f_submit');

    modal.dataset.mode = 'edit';
    modal.dataset.editId = String(p.id);

    titleEl.textContent = '編輯專案';
    submitBtn.textContent = '更新';

    modal.style.display = 'flex';

    const selRU = document.getElementById('f_responsible_user');
    await loadResponsibleOptionsInto(selRU,
      (p.responsible_user_id == null || p.responsible_user_id === '') ? '' : String(p.responsible_user_id)
    );

    document.getElementById('f_project_id').value = p.project_id ?? '';
    document.getElementById('f_name').value       = p.name ?? '';
    document.getElementById('f_stage').value      = String(p.stage_id ?? 0);
    document.getElementById('f_start_date').value = p.start_date ?? '';
    document.getElementById('f_estimated_days').value =
      (p.estimated_days ?? '') === null ? '' : (p.estimated_days ?? '');

    updateDuePreview();
    document.getElementById('f_project_id').disabled = true;
  }

  if (addBtn && modal && closeBtn) {
    // 新增
    addBtn.addEventListener('click', async () => {
      modal.dataset.mode = 'create';
      modal.dataset.editId = '';
      document.querySelector('#createModal .modal-title').textContent = '新增專案';
      document.getElementById('f_submit').textContent = '送出';

      modal.style.display = 'flex';
      await loadResponsibleOptionsInto(document.getElementById('f_responsible_user'), '');

      ['f_project_id','f_name','f_start_date','f_estimated_days'].forEach(id => document.getElementById(id).value = '');
      document.getElementById('f_stage').value = '0';
      document.getElementById('f_responsible_user').value = '';
      updateDuePreview();

      document.getElementById('f_project_id').disabled = false;
    });

    function closeModal() {
      modal.style.display = 'none';
      modal.dataset.mode = 'create';
      modal.dataset.editId = '';
      document.getElementById('f_project_id').disabled = false;
    }

    closeBtn.addEventListener('click', closeModal);
    document.getElementById('f_cancel').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    document.getElementById('f_start_date').addEventListener('change', updateDuePreview);
    document.getElementById('f_estimated_days').addEventListener('input', updateDuePreview);

    document.getElementById('f_submit').addEventListener('click', async () => {
      const mode  = modal.dataset.mode || 'create';
      const editId = modal.dataset.editId || null;

      const body = {
        project_id: document.getElementById('f_project_id').value.trim(),
        name:       document.getElementById('f_name').value.trim(),
        stage_id:   Number(document.getElementById('f_stage').value),
        start_date: document.getElementById('f_start_date').value || null,
        estimated_days: (() => {
          const v = document.getElementById('f_estimated_days').value;
          return v === '' ? null : Number(v);
        })(),
        responsible_user_id: (() => {
          const v = document.getElementById('f_responsible_user').value;
          return v === '' ? null : String(v);
        })(),
        creator_user_id: window.__ME__?.id ?? null,
        creator_user_name: window.__ME__?.name ?? window.__ME__?.username ?? null
      };

      if (mode === 'edit' && editId) {
        body.id = Number(editId);
      }

      if (!body.project_id || !body.name) {
        alert('請填寫：編號、案名');
        return;
      }

      try {
        await saveProject(body);
        closeModal();
        if (mode !== 'edit') {
          ['f_project_id','f_name','f_start_date','f_estimated_days'].forEach(id => document.getElementById(id).value = '');
          document.getElementById('f_stage').value = '0';
          document.getElementById('f_responsible_user').value = '';
          updateDuePreview();
        }
      } catch (e) {
        console.error('[SAVE] failed', e);
        alert('操作失敗：' + (e?.message || e));
      }
    });
  }

  // ------------------------------------------------------
  // 列表上的 ✏️ 🗑️ ✅
  // ------------------------------------------------------
  const gridEl = document.getElementById('projectsGrid');
  if (gridEl) {
    gridEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('.js-action');
      if (!btn) return;

      const action = btn.dataset.action;
      const idStr  = btn.dataset.dbId;
      const p      = projectsById.get(idStr);

      if (action === 'edit') {
        if (!p) { alert('找不到資料'); return; }
        openEditModal(p);
        return;
      }

      if (action === 'delete') {
        if (!p) { alert('找不到資料'); return; }
        const ok = confirm(`確定要刪除「${p.project_id}｜${p.name}」嗎？`);
        if (!ok) return;

        try {
          await apiFetch(`/api/projects/${idStr}`, { method: 'DELETE' });
          btn.closest('.project-row')?.remove();
          projectsById.delete(idStr);
        } catch (err) {
          console.error('[DELETE] failed', err);
          alert('刪除失敗：' + (err?.message || err));
        }
        return;
      }

      if (action === 'done') {
        if (!p) { alert('找不到資料'); return; }
        const ok = confirm(`要把「${p.project_id}｜${p.name}」標記為已完成嗎？`);
        if (!ok) return;

        try {
          const rowEl = btn.closest('.project-row');
          rowEl?.classList.add('is-done');
          rowEl.dataset.updatedAt = new Date().toISOString();

          apiFetch(`/api/projects/${idStr}`, {
            method: 'PATCH',
            body: { stage_id: 3 },
          }).catch(() => {});

          applyFilter();
          alert('已標記為已完成');
        } catch (err) {
          console.error('[DONE] failed', err);
          alert('操作失敗：' + (err?.message || err));
        }
        return;
      }
    });
  }

  // ------------------------------------------------------
  // 儲存批次更新
  // ------------------------------------------------------
  const saveBtn = document.getElementById('saveBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      if (dirty.size === 0) {
        Swal.fire({ icon: 'info', title: '沒有變更', timer: 800, showConfirmButton: false });
        return;
      }

      Swal.fire({
        title: '更新中...',
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading()
      });

      try {
        const jobs = Array.from(dirty.entries()).map(([id, patch]) =>
          apiFetch(`/api/projects/${id}`, {
            method: 'PATCH',
            body: patch,
          }).then(() => id)
        );

        const results = await Promise.allSettled(jobs);
        const successIds = results
          .filter(r => r.status === 'fulfilled')
          .map(r => r.value);

        for (const id of successIds) dirty.delete(id);

        Swal.close();

        if (successIds.length > 0) {
          Swal.fire({ icon: 'success', title: `已更新 ${successIds.length} 筆`, timer: 1000, showConfirmButton: false });
        }

        await loadAndRenderProjects();

        if (dirty.size === 0) {
          hideUnsavedNotice();
        }
      } catch (e) {
        Swal.close();
        console.error(e);
        Swal.fire('錯誤', '更新時發生錯誤', 'error');
      }
    });
  }

  // ------------------------------------------------------
  // 上傳對話框控制器（只初始化一次）
  // ------------------------------------------------------
  (function initUploadOnce() {
    if (window.__UPLOAD_WIRED__) return;
    window.__UPLOAD_WIRED__ = true;

    const uploadModal = document.getElementById('uploadModal');
    const uploadInput = document.getElementById('uploadInput');
    const chooseBtn   = document.getElementById('chooseFileBtn');
    const cancelBtn   = document.getElementById('cancelUploadBtn');
    const statusBox   = document.getElementById('uploadStatus');
    const hintBox     = document.getElementById('uploadHint');

    if (!uploadModal || !uploadInput || !chooseBtn || !cancelBtn || !statusBox || !hintBox) {
      console.warn('[projects] upload UI elements not found, skip initUploadOnce');
      return;
    }

    let current = { projectNo: null, stageNo: null, cellEl: null };

    window.openStageUpload = async function(projectNo, stageNo, cellEl) {
      current = { projectNo, stageNo, cellEl };
      hintBox.textContent = `案件編號：${projectNo}　階段：${stageNo}`;
      statusBox.innerHTML = '載入中…';
      uploadInput.value = '';
      uploadModal.style.display = 'flex';

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
          statusBox.textContent = '目前沒有上傳記錄';
        }
      } catch (err) {
        console.warn('load last file failed', err);
        statusBox.textContent = '無法取得上次上傳資訊';
      }
    };

    function closeUpload() {
      uploadModal.style.display = 'none';
      current = { projectNo: null, stageNo: null, cellEl: null };
    }

    chooseBtn.addEventListener('click', () => uploadInput.click());
    cancelBtn.addEventListener('click', () => closeUpload());

    uploadInput.addEventListener('change', async () => {
      if (!uploadInput.files || uploadInput.files.length === 0) return;

      statusBox.textContent = '上傳中…';
      try {
        const fd = new FormData();
        for (const f of uploadInput.files) fd.append('files', f);

        const data = await apiFetch(
          `/api/projects/${current.projectNo}/stages/${current.stageNo}/upload`,
          {
            method: 'POST',
            body: fd,
            isMultipart: true,
          }
        );

        if (!data.ok) throw new Error(data.error || '上傳失敗');

        if (current.cellEl) current.cellEl.dataset.state = 'done';

        statusBox.textContent = `✅ 已上傳 ${data.files?.length || uploadInput.files.length} 個檔案`;
        setTimeout(() => closeUpload(), 700);
      } catch (err) {
        statusBox.textContent = `❌ 錯誤：${err.message || err}`;
      }
    });
  })();

  // ------------------------------------------------------
  // 視窗關閉 / 重新整理：未儲存提示
  // ------------------------------------------------------
  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsavedChanges()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ------------------------------------------------------
  // 初始化：載入一次專案清單
  // ------------------------------------------------------
  loadAndRenderProjects();

  // 將 controller 暴露給外部（home.js）
  return {
    hasUnsavedChanges,
    confirmNavigateWhenDirty,
    discardUnsavedChanges,
    reload: loadAndRenderProjects,
  };
}
