// scripts/upload-to-drive.js  (CommonJS 版)
const { google } = require('googleapis');
const { Readable } = require('node:stream');

async function main() {
  const auth = await google.auth.getClient({
    scopes: [
      'https://www.googleapis.com/auth/drive.file',
      // 如遇權限不足再加開：
      // 'https://www.googleapis.com/auth/drive',
    ],
  });
  const drive = google.drive({ version: 'v3', auth });

  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) {
    console.error('❌ 未設定 DRIVE_FOLDER_ID，為避免上傳到錯誤位置，已中止。');
    process.exit(1);
  }
  console.log('📌 Target folderId =', folderId);

  try {
    const info = await drive.about.get({ fields: 'user,storageQuota', supportsAllDrives: true });
    console.log('📁 Drive 連線成功：登入帳號 →', info.data.user?.emailAddress);
  } catch (err) {
    console.error('❌ 驗證 Drive 失敗：', err?.response?.data || err);
    process.exit(1);
  }

  try {
    const res = await drive.files.create({
      requestBody: { name: 'hello.txt', parents: [folderId] },
      media: { mimeType: 'text/plain', body: Readable.from(['Hello from GitHub Actions with WIF!\n']) },
      fields: 'id,name,parents,webViewLink',
      supportsAllDrives: true,
    });
    console.log('✅ 上傳成功:', res.data);
  } catch (err) {
    console.error('❌ Drive upload failed:', err?.response?.data || err);
    process.exit(1);
  }
}

main().catch(err => { console.error('❌ Unexpected:', err); process.exit(1); });
