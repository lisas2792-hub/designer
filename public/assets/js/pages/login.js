// login.js：從 login.html 的 <script> 原封不動搬過來（只有移出來，內容不改）

// 根據當前協定決定 API 位置（保留原邏輯）
const API = location.protocol === "file:" 
    ? "http://127.0.0.1:3000/api/auth/login" 
    : "/api/auth/login";

const msg = document.getElementById("msg");
const btn = document.getElementById("btn");

// 如果是用 file:// 開，修正跳轉連結（保留原註解）
if (location.protocol === "file:") {
    document.getElementById("toRegister").href = "register.html";
}

btn.addEventListener("click", async () => {
    msg.textContent = ""; 
    msg.className = "msg";

    const body = {
    username: document.getElementById("username").value.trim(),
    password: document.getElementById("password").value
    };
    if (!body.username || !body.password) {
    msg.textContent = "請輸入帳號與密碼"; 
    msg.classList.add("error");
    return;
    }

    try {
    const res = await fetch(API, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        credentials: "include",               // ⬅️ 確保瀏覽器接受 Set-Cookie
        body: JSON.stringify(body)
    });

    // 後端固定回 JSON
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.ok) {
        // ⬅️ 若回傳 token，備用存起來（同站用不到，但之後 file:// 可拿來當 Bearer）
        if (data.token) {
        try { localStorage.setItem("jwt", data.token); } catch (_) {}
        }

        // ⬅️ 從後端回傳的 user 取 username；fallback 用表單輸入
        const uname = data?.user?.username ?? body.username;

        // ⬅️ 絕對路徑導到同站的 home（避免路徑/來源不一致）
        window.location.href = `/home.html?username=${encodeURIComponent(uname)}`;
    } else {
        msg.textContent = data?.msg || `登入失敗（HTTP ${res.status}）`;
        msg.classList.add("error");
    }

    } catch (e) {
    console.error(e);
    msg.textContent = "無法連到伺服器 (server.js)"; 
    msg.classList.add("error");
    }
});

// 為了直接按 Enter 即可模擬點擊登入按鈕（保留原註解）
document.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
    btn.click();
    }
});