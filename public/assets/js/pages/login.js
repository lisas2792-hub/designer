// 認證頁（登入）：使用統一的 api.js（可直接上線）
// - 使用 api.auth.login() 呼叫後端
// - 若後端回 token → 用 setToken() 儲存（供後續 Bearer）
// - 不硬寫 localhost；API_BASE 由 api.js 自動處理 (http/https/file://)

import { api, setToken, toUserMessage } from "/assets/js/api.js";

const msg = document.getElementById("msg");
const btn = document.getElementById("btn");

// file:// 開啟時，修正註冊超連結（保留你的行為）
if (location.protocol === "file:") {
  const reg = document.getElementById("toRegister");
  if (reg) reg.href = "register.html";
}

btn.addEventListener("click", onLogin);
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btn.click();
});

async function onLogin() {
  resetMsg();

  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  if (!username || !password) {
    showError("請輸入帳號與密碼");
    return;
  }

  try {
    // 呼叫後端登入；需對應你的後端回傳格式
    // 常見回傳：{ ok: true, token, user: { username, name, role } }
    const data = await api.auth.login({ username, password });

    // 若後端同時設置 httpOnly Cookie，這裡也不衝突；token 僅作為前端 Bearer 備援
    if (data?.token) {
      setToken(data.token);
    } else {
      // 沒有 token 也可能僅靠 Cookie 驗證；此情況下可略過 setToken()
      // 若你後端只用 Cookie，這裡不需做額外處理
    }

    // 取得顯示用名稱：user.username → user.name → 表單輸入
    const uname =
      data?.user?.username ??
      data?.user?.name ??
      username;

    // 絕對路徑導回首頁（避免子路徑問題）
    // window.location.href = `/home.html?username=${encodeURIComponent(uname)}`;
    window.location.href = `/home.html`;
  } catch (err) {
    // 使用統一錯誤訊息轉換（401/403/逾時/網路）
    showError(toUserMessage(err, "登入失敗，請稍後再試"));
  }
}

/* ---------------- 小工具：訊息區域 ---------------- */
function resetMsg() {
  msg.textContent = "";
  msg.className = "msg";
}

function showError(text) {
  msg.textContent = text;
  msg.classList.add("error");
}
