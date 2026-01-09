@echo off
echo START DEPLOY

set SERVICE=designer-app
set REGION=asia-east1

echo STEP 0 - GIT SHA
set SHA=nogit
git rev-parse --short HEAD >nul 2>&1
if errorlevel 1 goto SKIP_GIT
for /f %%i in ('git rev-parse --short HEAD') do set SHA=%%i
:SKIP_GIT
echo GIT_SHA=%SHA%

echo STEP 1 - DEPLOY
call gcloud run deploy %SERVICE% --region=%REGION% --source=.

echo STEP 2 - TIMESTAMP
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set TS=%%i
set VER=v%TS%
echo VERSION=%VER%

echo STEP 3 - UPDATE ENV (VERSION/BUILD_ID/GIT_SHA)
call gcloud run services update %SERVICE% --region=%REGION% --update-env-vars VERSION=%VER%,BUILD_ID=%VER%,GIT_SHA=%SHA%

echo DONE
pause
