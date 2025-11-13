// ======================================================
//  共用 API 工具：用來與後端溝通（GET / POST）
//  - 自動帶上 Bearer Token
//  - 自動組合 API_BASE
//  - 可直接上線使用
// ======================================================

/* ========================= 基本設定 ========================= */

// 僅在「本地用 file:// 打開 HTML」時，才回落到 127.0.0.1
const API_BASE = location.protocol.startsWith("http") ? "" : "http://127.0.0.1:3000";

// 逾時秒數（可依需求調整）
const DEFAULT_TIMEOUT_MS = 15000;

// 從安全的儲存位置讀/寫 Token（這裡以 localStorage 為例；也可改 cookie）
const TOKEN_KEY = "authToken";

/* ========================= 工具方法 ========================= */

function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setToken(token = "") {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

function buildHeaders(extra = {}, { isMultipart = false } = {}) {
  const h = {
    "X-Requested-With": "XMLHttpRequest",
    ...extra,
  };
  // multipart 時不手動設 Content-Type，讓瀏覽器自帶 boundary
  if (!isMultipart && !("Content-Type" in h)) {
    h["Content-Type"] = "application/json; charset=utf-8";
  }
  const token = getToken();
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

async function apiFetch(path, { method = "GET", body, headers = {}, timeout = DEFAULT_TIMEOUT_MS, isMultipart = false } = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  const url = `${API_BASE}${path}`;

  // body：若非 multipart，物件自動 JSON.stringify
  let finalBody = body;
  if (body && !isMultipart && typeof body === "object") {
    finalBody = JSON.stringify(body);
  }

  const res = await fetch(url, {
    method,
    headers: buildHeaders(headers, { isMultipart }),
    body: finalBody,
    credentials: "same-origin",
    signal: controller.signal,
  }).catch((err) => {
    clearTimeout(id);
    // 網路層錯誤（DNS、CORS、逾時…）
    const e = new Error("Network error");
    e.cause = err;
    e.code = "NETWORK_ERROR";
    throw e;
  });

  clearTimeout(id);

  // 204 No Content
  if (res.status === 204) return {};

  // 嘗試解析 JSON；若非 JSON 以純文字回傳
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    // 標準化錯誤物件
    const e = new Error(data?.message || data?.error || `HTTP ${res.status}`);
    e.status = res.status;
    e.code = data?.code || "HTTP_ERROR";
    e.details = data;
    throw e;
  }

  return data;
}

/* ========================= API：領域方法 ========================= */

export const api = {
  /* ---------- 認證相關 ---------- */
  auth: {
    // 依你的後端而定：例如 POST /api/auth/login 取得 token
    async login({ username, password }) {
      const data = await apiFetch("/api/auth/login", {
        method: "POST",
        body: { username, password },
      });
      // 假設後端回 { token, user }
      if (data?.token) setToken(data.token);
      return data;
    },

    // 統一回傳「目前登入者物件」或 null
    async me() {
      const res = await apiFetch("/api/auth/me", { method: "GET" });
      return res?.data ?? null;
    },

    async logout() {
      // 後端若有登出端點可呼叫；否則僅清 Token
      try {
        await apiFetch("/api/auth/logout", { method: "POST" });
      } catch {
        // 即使後端無此路由也不影響前端登出流程
      }
      setToken("");
      return true;
    },

    async register({ username, password, name }) {
      return await apiFetch("/api/auth/register", {
        method: "POST",
        body: { username, password, name },
      });
    },
  },

  /* ---------- 專案/清單 ---------- */
  projects: {
    async list({ keyword = "", page = 1, pageSize = 20 } = {}) {
      const qs = new URLSearchParams({ keyword, page: String(page), pageSize: String(pageSize) });
      return await apiFetch(`/api/projects?${qs.toString()}`, { method: "GET" });
    },

    async get(projectId) {
      return await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "GET" });
    },
  },

  /* ---------- 階段規劃（stageplan）---------- */
  stagePlan: {
    // 取某專案的階段規劃
    async get(projectId) {
      return await apiFetch(`/api/stageplan/${encodeURIComponent(projectId)}/stage-plan`, { method: "GET" });
    },

    // 儲存/更新某專案的階段規劃
    async save(projectId, payload) {
      // 後端可用 PUT /api/stageplan/:id/stage-plan
      return await apiFetch(`/api/stageplan/${encodeURIComponent(projectId)}/stage-plan`, {
        method: "PUT",
        body: payload, // 物件自動轉 JSON
      });
    },

    // 例如：切換單一階段狀態（如「完成/未完成/日期」）
    async updateStage(projectId, stageId, payload) {
      return await apiFetch(`/api/stageplan/${encodeURIComponent(projectId)}/stage/${encodeURIComponent(stageId)}`, {
        method: "PATCH",
        body: payload,
      });
    },
  },

  /* ---------- 上傳（stageupload）---------- */
  stageUpload: {
    // 查詢最後一次上傳紀錄
    async getLast(projectId) {
      return await apiFetch(`/api/stageupload/${encodeURIComponent(projectId)}/last`, { method: "GET" });
    },

    // 上傳檔案：file 必須是 File/Blob；可帶 stageId 讓後端辨識八階段
    async upload({ projectId, stageId, file, extra = {} }) {
      const form = new FormData();
      form.append("file", file);
      if (stageId != null) form.append("stageId", String(stageId));
      // 其餘欄位（如備註、檔名、是否覆蓋…）
      Object.entries(extra).forEach(([k, v]) => form.append(k, String(v)));

      return await apiFetch(`/api/stageupload/${encodeURIComponent(projectId)}/upload`, {
        method: "POST",
        body: form,
        isMultipart: true,
      });
    },
  },

  /* ---------- 雜項 ---------- */
  ping() {
    return apiFetch("/api/healthz", { method: "GET", timeout: 5000 });
  },
};

/* ========================= 方便的錯誤處理輔助 ========================= */

// 將錯誤轉成可顯示訊息（可在 UI 層統一使用）
export function toUserMessage(err, fallback = "發生未知錯誤，請稍後再試") {
  if (!err) return fallback;
  if (err.status === 401) return "尚未登入或登入已過期，請重新登入。";
  if (err.status === 403) return "您沒有權限執行此操作。";
  if (err.code === "NETWORK_ERROR") return "網路或伺服器連線異常，請確認網路後再試。";
  // 後端若有帶更明確的 message
  if (err?.details?.message) return String(err.details.message);
  if (err?.details?.msg)     return String(err.details.msg);
  if (err.message) return String(err.message);
  return fallback;
}
