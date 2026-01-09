@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM =========================================================
REM deploy.cmd
REM - Deploy to Cloud Run (designer-app, asia-east1)
REM - Auto timestamp VERSION/BUILD_ID
REM - Auto set GIT_SHA (if git available)
REM - Auto tag the latest revision with the same timestamp
REM - Never wipe existing env vars (uses --update-env-vars)
REM =========================================================

set SERVICE=designer-app
set REGION=asia-east1
set PROJECT=project-designer-476408
set URL=https://designer-app-909118568673.asia-east1.run.app

echo.
echo [1/7] Check project root...
if not exist Dockerfile (
  echo [ERROR] Dockerfile not found. Please run deploy.cmd in project root.
  exit /b 1
)
if not exist package.json (
  echo [ERROR] package.json not found. Please run deploy.cmd in project root.
  exit /b 1
)

echo.
echo [2/7] Ensure gcloud project...
gcloud config set project %PROJECT% >nul 2>&1
if errorlevel 1 (
  echo [ERROR] gcloud not ready. Please run: gcloud auth login
  exit /b 1
)

echo.
echo [3/7] Generate timestamp...
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set TS=%%i
if "%TS%"=="" (
  echo [ERROR] Failed to generate timestamp.
  exit /b 1
)
set VER=v%TS%
echo         VER=%VER%

echo.
echo [4/7] Read git short SHA (optional)...
set SHA=nogit
git rev-parse --short HEAD >nul 2>&1
if %errorlevel%==0 (
  for /f %%i in ('git rev-parse --short HEAD') do set SHA=%%i
)
echo         SHA=%SHA%

echo.
echo [5/7] Deploy from source (build + new revision)...
gcloud run deploy %SERVICE% --region=%REGION% --source=. --quiet
if errorlevel 1 (
  echo [ERROR] Deploy failed. Check Cloud Build logs.
  exit /b 1
)

echo.
echo [6/7] Update env vars (keep all existing env vars)...
gcloud run services update %SERVICE% --region=%REGION% --update-env-vars VERSION=%VER%,BUILD_ID=%VER%,GIT_SHA=%SHA% --quiet
if errorlevel 1 (
  echo [ERROR] Failed to update env vars. Service deployed but version vars may not be updated.
  exit /b 1
)

echo.
echo [7/7] Tag latest revision with timestamp (for easy identification)...
REM Get latest ready revision name
for /f "usebackq delims=" %%r in (`gcloud run services describe %SERVICE% --region=%REGION% --format="value(status.latestReadyRevisionName)"`) do set LATEST_REV=%%r

if "%LATEST_REV%"=="" (
  echo [WARN] Cannot read latest revision name. Skip tagging.
) else (
  echo         Latest revision: %LATEST_REV%
  echo         Tag: %VER%
  gcloud run services update-traffic %SERVICE% --region=%REGION% --set-tags %VER%=%LATEST_REV% --quiet
  if errorlevel 1 (
    echo [WARN] Tagging failed (may be due to permissions). Continue.
  )
)

echo.
echo [DONE] Deployed. Confirming /api/version ...
echo ---------------------------------------------------------
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing '%URL%/api/version').Content } catch { $_.Exception.Message }"
echo ---------------------------------------------------------
echo NOTE:
echo - Cloud Run internal revision name (designer-app-000xx-xxx) is platform-generated and will not be a timestamp.
echo - Use Tag [%VER%] and VERSION/BUILD_ID to identify builds.
echo.
endlocal
exit /b 0
