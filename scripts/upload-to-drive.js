// scripts/upload-to-drive.js  (CommonJS 版)
const { google } = require('googleapis');
const { Readable } = require('node:stream');

async function main() {
  // 透過 ADC 取得 WIF 臨時憑證
  const auth = await google.auth.getClient({
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  const drive = google.drive({ version: 'v3', auth });

  // 與 workflow/Secrets 一致：DRIVE_FOLDER_ID
  const folderId = process.env.DRIVE_FOLDER_ID;
  const parents = folderId ? [folderId] : undefined;
  console.log('📌 Target folderId =', folderId || '(未設定，將上傳到 SA 的 My Drive)');

  // 驗證 Drive 連線
  try {
    const info = await drive.about.get({
      fields: 'user,storageQuota',
      supportsAllDrives: true,
    });
    console.log('📁 Drive 連線成功：登入帳號 →', info.data.user?.emailAddress);
  } catch (err) {
    console.error('❌ 驗證 Drive 失敗：', err?.response?.data || err);
    process.exit(1);
  }

  // 上傳測試檔
  try {
    const res = await drive.files.create({
      requestBody: { name: 'hello.txt', parents },
      media: {
        mimeType: 'text/plain',
        body: Readable.from(['Hello from GitHub Actions with WIF!\n']),
      },
      fields: 'id,name,webViewLink,parents',
      supportsAllDrives: true,
    });
    console.log('✅ 上傳成功:', res.data);
  } catch (err) {
    console.error('❌ Drive upload failed:', err?.response?.data || err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('❌ Unexpected:', err);
  process.exit(1);
});
