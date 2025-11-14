// 修改密碼專用：負責表單驗證 + 呼叫後端 API
// 依賴 api.js 提供的 api / toUserMessage

import { api, toUserMessage } from "../api.js";

/**
 * 初始化修改密碼功能
 * - 預期 HTML 會有：
 *   - input#oldPwd
 *   - input#newPwd
 *   - input#newPwd2
 *   - button#savePwd
 *   - span/div#pwdMsg 顯示訊息
 *
 * @param {Object} options
 * @param {Function} [options.onSuccess] 密碼修改成功後要做的事（可省略）
 */
export function initPasswordFeature(options = {}) {
  const { onSuccess } = options;

  const btn = document.getElementById("savePwd");
  const oldInput = document.getElementById("oldPwd");
  const newInput = document.getElementById("newPwd");
  const newInput2 = document.getElementById("newPwd2");
  const msg = document.getElementById("pwdMsg");

  // 沒有這些元素就直接略過，避免在其它頁報錯
  if (!btn || !oldInput || !newInput || !newInput2 || !msg) {
    console.warn("[password.js] 未找到密碼表單元素，略過初始化");
    return {
      reset() {},
    };
  }

  function showMsg(text, color = "#6b7280") {
    msg.style.color = color;
    msg.textContent = text || "";
  }

  function reset() {
    oldInput.value = "";
    newInput.value = "";
    newInput2.value = "";
    showMsg("");
  }

  btn.addEventListener("click", async () => {
    const oldPwd = oldInput.value.trim();
    const newPwd = newInput.value.trim();
    const newPwd2 = newInput2.value.trim();

    showMsg("");

    // 基本驗證
    if (!oldPwd || !newPwd || !newPwd2) {
      showMsg("請完整填寫所有欄位", "#b91c1c");
      return;
    }

    if (newPwd.length < 6) {
      showMsg("新密碼長度需至少 6 碼", "#b91c1c");
      return;
    }

    // 若要強制英數混合 → 解開以下註解
    // if (!/(?=.*[A-Za-z])(?=.*\d).{6,}/.test(newPwd)) {
    //   showMsg("密碼需至少6碼，且包含英文字母與數字", "#b91c1c");
    //   return;
    // }

    if (newPwd !== newPwd2) {
      showMsg("兩次輸入的新密碼不一致", "#b91c1c");
      return;
    }

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "送出中…";

    try {
      await api.auth.changePassword({
        current_password: oldPwd,
        new_password: newPwd,
        confirm_password: newPwd2,
      });
      // 上面會自動處理 token 更新（在 api.js 裡）

      showMsg("密碼已更新，下次登入請使用新密碼", "#065f46");
      reset();

      if (typeof onSuccess === "function") onSuccess();
    } catch (err) {
      console.error("[changePassword] error:", err);
      showMsg(toUserMessage(err, "修改密碼失敗，請稍後再試"), "#b91c1c");
    } finally {
      btn.disabled = false;
      btn.textContent = originalText || "儲存";
    }
  });

  return { reset };
}
