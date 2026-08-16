@echo off
setlocal EnableExtensions
title DeepSeek Harness Portable - Upgrade

rem ============================================================
rem  DeepSeek Harness Portable - one-click upgrade (folder edition)
rem  Checks npm for the newest @deepseek-ai/dsh and updates this
rem  folder's app in place. User data under .\data is NEVER touched.
rem ============================================================

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"

set "NODE_EXE=%APP_DIR%\runtime\node\node.exe"
set "UPGRADE_SCRIPT=%APP_DIR%\upgrade.mjs"
if not exist "%NODE_EXE%" (
  echo [ERROR] Embedded Node.js runtime not found: "%NODE_EXE%"
  pause
  exit /b 1
)
if not exist "%UPGRADE_SCRIPT%" (
  echo [ERROR] upgrade script not found: "%UPGRADE_SCRIPT%"
  pause
  exit /b 1
)

chcp 65001 >nul 2>&1
cd /d "%APP_DIR%"
"%NODE_EXE%" "%UPGRADE_SCRIPT%" %*
set "EXIT_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %EXIT_CODE%
