@echo off
setlocal enabledelayedexpansion

echo START DEPLOY

set SERVICE=designer-app
set REGION=asia-east1
set PROJECT=project-designer-476408

echo STEP 0 - GIT SHA
set SHA=nogit
git rev-parse --short HEAD >nul 2>&1
if errorlevel 1 goto SKIP_GIT
for /f %%i in ('git rev-parse --short HEAD') do set SHA=%%i
:SKIP_GIT
echo GIT_SHA=%SHA%

echo STEP 0.5 - SET GCLOUD PROJECT
call gcloud config set project %PROJECT% >nul

echo STEP 1 - DEPLOY
call gcloud run deploy %SERVICE% ^
  --project=%PROJECT% ^
  --region=%REGION% ^
  --source=. ^
  --allow-unauthenticated

if errorlevel 1 goto FAIL

echo STEP 2 - TIMESTAMP
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set TS=%%i
set VER=v%TS%
echo VERSION=%VER%

echo STEP 3 - UPDATE ENV (VERSION/BUILD_ID/GIT_SHA)
call gcloud run services update %SERVICE% ^
  --project=%PROJECT% ^
  --region=%REGION% ^
  --update-env-vars VERSION=%VER%,BUILD_ID=%VER%,GIT_SHA=%SHA%

if errorlevel 1 goto FAIL

echo DONE
pause
exit /b 0

:FAIL
echo DEPLOY FAILED
pause
exit /b 1
