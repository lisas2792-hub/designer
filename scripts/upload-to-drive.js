// scripts/upload-to-drive.js
import { google } from 'googleapis';
import { Readable } from 'node:stream';

async function main() {
  // 取得臨時憑證（WIF）
  const auth = await google.auth.getClient({
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  const drive = google.drive({ version: 'v3', auth });

  // 用 GitHub Secret 傳入的資料夾 ID（建議名稱：DRIVE_FOLDER_ID）
  const folderId = process.env.DRIVE_FOLDER_ID;
  const parents = folderId ? [folderId] : undefined;
  console.log('📌 Target folderId =', folderId || '(未設定，將上傳到 SA 的 My Drive)');

  // 驗證連線
  try {
    const info = await drive.about.get({
      fields: 'user,storageQuota',
      supportsAllDrives: true,
    });
    console.log('📁 Drive 連線成功：', info.data.user?.emailAddress);
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
