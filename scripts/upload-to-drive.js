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

  // 上傳一個簡單檔案作為驗證
  const res = await drive.files.create({
    requestBody: { name: 'hello.txt', parents },
    media: { mimeType: 'text/plain', body: 'Hello from GitHub Actions with WIF!' },
    fields: 'id,name,webViewLink',
  });

  console.log('✅ Uploaded:', res.data);
}

main().catch(err => {
  console.error('❌ Drive upload failed:', err?.response?.data || err);
  process.exit(1);
});
