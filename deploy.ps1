<#
  Enterprise Deploy Script for Cloud Run (PowerShell)
  - Auto versioning/labels/env
  - Cloud Build -> Artifact Registry
  - Deploy with --no-traffic, health check, then shift traffic
  - Canary ready, rollback on failure
  - Clean old images and old revisions
  - Output deploy report JSON
#>

param(
  # ===== 基本設定 =====
  [string]$ProjectId    = "project-designer-476408",
  [string]$Region       = "asia-east1",
  [string]$ServiceName  = "designer-app",
  [string]$RepoName     = "designer-app",
  [string]$ImageName    = "designer-app",

  # ===== 流量與金絲雀 =====
  [switch]$UseCanary,                 # 使用金絲雀分流（若不帶則直接 100% 切到新修訂）
  [int]$CanaryPercent = 5,            # 首波金絲雀百分比
  [int]$CanaryHoldSec = 60,           # 金絲雀觀察秒數（健康才全量）

  # ===== 清理策略 =====
  [int]$KeepImages    = 5,            # Artifact Registry 保留最新 N 個 tag
  [int]$KeepRevisions = 5,            # Cloud Run 修訂版保留最新 N 個（無流量者優先清）

  # ===== 資源與網路 =====
  [string]$Cpu        = "1",          # 例："1" 或 "2"
  [string]$Memory     = "512Mi",      # 例："512Mi"、"1Gi"
  [string]$Timeout    = "300s",       # 例："300s"
  [int]$MinInstances  = 0,
  [int]$MaxInstances  = 10,
  [int]$Concurrency   = 80,
  [string]$Ingress    = "all",        # all / internal-and-cloud-load-balancing / internal
  [string]$ServiceAccount = "",       # 可填你的 SA email（空字串則不指定）

  # ===== 環境變數來源（可選）=====
  [string]$EnvFile    = ".env.deploy" # 可放 KEY=VALUE；# 開頭為註解
)

$ErrorActionPreference = "Stop"

# ─────────────────────────────────────────────────────────
# 小工具：輸出/錯誤/執行
function Info($s){ Write-Host ("[INFO] " + $s) -ForegroundColor Cyan }
function Warn($s){ Write-Host ("[WARN] " + $s) -ForegroundColor Yellow }
function Err ($s){ Write-Host ("[ERR ] " + $s) -ForegroundColor Red }
function Run($cmd){
  Info $cmd
  iex $cmd
  if ($LASTEXITCODE -ne 0) { throw "Command failed: $cmd" }
}
# ─────────────────────────────────────────────────────────

# 版本資訊（人看 & 系統追蹤）
$VERSION     = "v$(Get-Date -Format 'yyyyMMdd-HHmmss')"   # 例：v20251126-154233
$BUILD_ID    = $VERSION                                   # 沒 CI 先沿用 VERSION（可接 CI build-number）
try {
  $GIT_SHA = (git rev-parse --short HEAD) 2>$null
  if (-not $GIT_SHA) { $GIT_SHA = "0000000" }
} catch { $GIT_SHA = "0000000" }

# 映像路徑
$AR_HOST        = "${Region}-docker.pkg.dev"
$IMAGE_BASENAME = "$AR_HOST/$ProjectId/$RepoName/$ImageName"
$IMAGE_URI      = "$IMAGE_BASENAME`:$VERSION"

# CORS 預設（你可改成自己的）
if (-not $env:CORS_ORIGINS) {
  $env:CORS_ORIGINS = "https://designer-app-909118568673.asia-east1.run.app,http://localhost:3000,http://127.0.0.1:3000"
}

Write-Host "========================================================="
Write-Host " 🚀 Cloud Run 部署開始"
Write-Host "  Project   : $ProjectId"
Write-Host "  Region    : $Region"
Write-Host "  Service   : $ServiceName"
Write-Host "  ImageBase : $IMAGE_BASENAME"
Write-Host "  ImageURI  : $IMAGE_URI"
Write-Host "  VERSION   : $VERSION"
Write-Host "  BUILD_ID  : $BUILD_ID"
Write-Host "  GIT_SHA   : $GIT_SHA"
$canaryMsg = "OFF"
if ($UseCanary.IsPresent) { $canaryMsg = "ON ($CanaryPercent% / $CanaryHoldSec s)" }
Write-Host ("  Canary    : " + $canaryMsg)
Write-Host "========================================================="

# 前置檢查
Info "前置檢查：gcloud 登入與專案設定"
$acct = (gcloud auth list --filter=status:ACTIVE --format="value(account)") 2>$null
if (-not $acct) { throw "尚未登入 gcloud：請先執行 gcloud auth login" }

$proj = (gcloud config get-value project) 2>$null
if ($proj -ne $ProjectId) {
  Warn "目前 gcloud 專案為 $proj，將切換到 $ProjectId"
  Run "gcloud config set project $ProjectId"
}

Info "確保必要 API 已啟用（artifactregistry, cloudbuild, run）"
Run "gcloud services enable artifactregistry.googleapis.com"
Run "gcloud services enable cloudbuild.googleapis.com"
Run "gcloud services enable run.googleapis.com"

Info "設定 Docker 認證至 $AR_HOST"
Run "gcloud auth configure-docker $AR_HOST -q"

# 合併環境變數：固定值 + 可選 EnvFile
$envKVs = @{}
$envKVs["VERSION"]       = $VERSION
$envKVs["BUILD_ID"]      = $BUILD_ID
$envKVs["GIT_SHA"]       = $GIT_SHA
$envKVs["CORS_ORIGINS"]  = $env:CORS_ORIGINS

if (Test-Path $EnvFile) {
  Info "讀取環境檔 $EnvFile"
  Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $pair = $line -split "=", 2
    if ($pair.Count -eq 2) {
      $k = $pair[0].Trim()
      $v = $pair[1].Trim()
      if ($k) { $envKVs[$k] = $v }
    }
  }
} else {
  Warn "找不到 $EnvFile，略過（可選）。"
}

# 將合併後的環境變數寫入暫存檔（YAML map 格式，gcloud --env-vars-file 需要）
$tmpEnv = [System.IO.Path]::GetTempFileName()

function ToYamlValue([string]$v) {
  # 單引號包起來，將內部單引號轉成兩個單引號，確保逗號/等號/冒號都安全
  return "'" + ($v -replace "'", "''") + "'"
}
$yamlLines = $envKVs.GetEnumerator() | ForEach-Object {
  "{0}: {1}" -f $_.Key, (ToYamlValue $_.Value)
}

# 用 ASCII 可避免舊版 Windows PowerShell UTF8-BOM 造成解析問題
Set-Content -Path $tmpEnv -Value $yamlLines -Encoding ASCII

Write-Host "[INFO] 環境變數暫存檔(YAML)：$tmpEnv"
# 如需檢查內容，可暫時打開下一行
# Get-Content $tmpEnv | ForEach-Object { Write-Host ("  " + $_) }


# 儲存版本檔（可供前端或備查）
"APP_VERSION=$VERSION" | Out-File -Encoding utf8 "./version.txt"

# 建置與推送（Cloud Build）
Info "Cloud Build submit → $IMAGE_URI"
Run "gcloud builds submit --tag `"$IMAGE_URI`""

# 建 revision-suffix（名稱不能含大寫或部分符號，簡單處理）
$revSuffix = ($VERSION -replace '[^a-zA-Z0-9-]', '-').ToLower()

# 部署（先不導入流量，健康才切）
Info "Deploy 到 Cloud Run（--no-traffic），注入資源設定/labels/env"
$deployCmd = @(
  "gcloud run deploy $ServiceName",
  "--image `"$IMAGE_URI`"",
  "--region $Region",
  "--platform managed",
  "--allow-unauthenticated",
  "--no-traffic",
  "--revision-suffix $revSuffix",
  "--env-vars-file `"$tmpEnv`"",
  "--labels `"version=$VERSION,build_id=$BUILD_ID,git_sha=$GIT_SHA`"",
  "--cpu $Cpu",
  "--memory $Memory",
  "--concurrency $Concurrency",
  "--timeout $Timeout",
  "--min-instances $MinInstances",
  "--max-instances $MaxInstances",
  "--ingress $Ingress"
)

if ($ServiceAccount -and $ServiceAccount.Trim().Length -gt 0) {
  $deployCmd += "--service-account $ServiceAccount"
}

Run ($deployCmd -join " ")

# 取得服務 URL 與最新修訂版
Info "取得服務 URL"
$ServiceUrl = (gcloud run services describe $ServiceName --region $Region --format="value(status.url)")
if (-not $ServiceUrl) { throw "無法取得服務 URL，請檢查 deploy 輸出" }
Write-Host "🌐 Service URL: $ServiceUrl"

Info "取得最新修訂版名稱"
$NewRev = (gcloud run revisions list --service $ServiceName --region $Region --sort-by="~createTime" --format="value(name)" | Select-Object -First 1)
if (-not $NewRev) { throw "無法取得最新修訂版名稱" }
Write-Host "🧾 New Revision: $NewRev"

# 健康檢查（/version 與 /api/health）
function Test-Endpoint($url, $timeoutSec=20){
  try {
    $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeoutSec
    if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) { return $true }
    return $false
  } catch { return $false }
}

Info "健康檢查：/version"
$ok1 = Test-Endpoint "$ServiceUrl/version"
Info "健康檢查：/api/health"
$ok2 = Test-Endpoint "$ServiceUrl/api/health"

if (-not ($ok1 -and $ok2)) {
  Err "健康檢查失敗：不切流量，嘗試回滾到上一個修訂版"
  # 回滾：找上一個有流量或上一個修訂版
  $Prev = (gcloud run revisions list --service $ServiceName --region $Region --sort-by="~createTime" --format="value(name)" | Select-Object -Skip 1 -First 1)
  if ($Prev) {
    Warn "回滾流量到 $Prev"
    Run "gcloud run services update-traffic $ServiceName --region $Region --to-revisions $Prev=100"
  } else {
    Warn "沒有上一個修訂版可回滾，請手動確認"
  }
  throw "部署失敗（健康檢查未通過）"
}

# 健康 → 切流量
if ($UseCanary.IsPresent) {
  Info "金絲雀: 將 $CanaryPercent% 流量導入 $NewRev，觀察 $CanaryHoldSec 秒"
  Run "gcloud run services update-traffic $ServiceName --region $Region --to-revisions $NewRev=$CanaryPercent"
  Start-Sleep -Seconds $CanaryHoldSec
  Info "再度健康檢查"
  if (-not (Test-Endpoint "$ServiceUrl/version" -timeoutSec 10)) {
    Err "金絲雀階段健康檢查失敗，回滾"
    $Prev = (gcloud run revisions list --service $ServiceName --region $Region --sort-by="~createTime" --format="value(name)" | Select-Object -Skip 1 -First 1)
    if ($Prev) {
      Run "gcloud run services update-traffic $ServiceName --region $Region --to-revisions $Prev=100"
    }
    throw "金絲雀失敗，已回滾"
  }
}

Info "切換 100% 流量到 $NewRev"
Run "gcloud run services update-traffic $ServiceName --region $Region --to-revisions $NewRev=100"

# 清理：舊 images（保留最新 N tag）
try {
  Info "清理 Artifact Registry 舊 Images（保留 $KeepImages 個 tag）"
  $tags = gcloud artifacts docker tags list "$IMAGE_BASENAME" --format="get(tag)" | Sort-Object -Descending
  $toDelete = $tags | Where-Object { $_ -and $_.Trim() } | Select-Object -Skip $KeepImages
  foreach ($t in $toDelete) {
    Info "刪除 $IMAGE_BASENAME`:$t"
    gcloud artifacts docker images delete "$IMAGE_BASENAME`:$t" --quiet
  }
} catch { Warn "清理 Images 失敗：$($_.Exception.Message)" }

# 清理：舊 revisions（無流量者優先）
try {
  Info "清理 Cloud Run 舊 Revisions（保留 $KeepRevisions 個）"
  $allRevs = gcloud run revisions list --service $ServiceName --region $Region --sort-by="~createTime" --format="value(name)"
  $toPrune = $allRevs | Select-Object -Skip $KeepRevisions
  foreach ($r in $toPrune) {
    Info "刪除修訂版 $r"
    gcloud run revisions delete $r --region $Region --quiet
  }
} catch { Warn "清理 Revisions 失敗：$($_.Exception.Message)" }

# 產出部署報告
$report = [ordered]@{
  project    = $ProjectId
  region     = $Region
  service    = $ServiceName
  version    = $VERSION
  build_id   = $BUILD_ID
  git_sha    = $GIT_SHA
  image_uri  = $IMAGE_URI
  revision   = $NewRev
  url        = $ServiceUrl
  time       = (Get-Date).ToString("s")
}
$reportJson = ($report | ConvertTo-Json -Depth 5)
$reportDir = "deploy_reports"
if (-not (Test-Path $reportDir)) { New-Item -ItemType Directory -Path $reportDir | Out-Null }
$reportPath = Join-Path $reportDir "deploy-$($VERSION).json"
$reportJson | Out-File -Encoding utf8 $reportPath

Write-Host ""
Write-Host "========================================================="
Write-Host "✅ 部署成功！"
Write-Host "    URL: $ServiceUrl"
Write-Host "    Revision: $NewRev"
Write-Host "    Version: $VERSION"
Write-Host "    Report: $reportPath"
Write-Host "========================================================="

# 部署成功後刪除暫存環境變數檔
if (Test-Path $tmpEnv) { Remove-Item $tmpEnv -Force -ErrorAction SilentlyContinue }

# 自動開站 + 提供 tail logs 指令提示
Start-Process $ServiceUrl
Write-Host "即時 Log（可選）："
Write-Host "  gcloud logs tail --region $Region --service $ServiceName"
