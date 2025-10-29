// scripts/upload-to-drive.js
import { google } from 'googleapis';

async function main() {
  // 透過 ADC 取得剛剛 auth 動作授與的臨時憑證
  const auth = await google.auth.getClient({
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  const drive = google.drive({ version: 'v3', auth });

  // （可選）指定要上傳到的資料夾 ID：把你的資料夾 ID 填到環境變數 FOLDER_ID
  const parents = process.env.FOLDER_ID ? [process.env.FOLDER_ID] : undefined;

  // -----------------------------------------------------------
  // ✅ 驗證是否真的登入成功（新增這段）
  try {
    const info = await drive.about.get({
      fields: 'user,storageQuota',
      supportsAllDrives: true, // ★ 若上傳到共享雲端硬碟必加
    });
    console.log('📁 Drive 連線成功：登入帳號 →', info.data.user?.emailAddress);
  } catch (err) {
    console.error('❌ 驗證 Drive 失敗：', err?.response?.data || err);
    process.exit(1);
  }
  // -----------------------------------------------------------

  // 上傳一個簡單檔案作為驗證
  const res = await drive.files.create({
    requestBody: { name: 'hello.txt', parents },
    media: { mimeType: 'text/plain', body: 'Hello from GitHub Actions with WIF!' },
    fields: 'id,name,webViewLink',
    supportsAllDrives: true, // ★ 共享雲端硬碟必加
  });

  console.log('✅ 上傳成功:', res.data);
}

main().catch(err => {
  console.error('❌ Drive upload failed:', err?.response?.data || err);
  process.exit(1);
});
