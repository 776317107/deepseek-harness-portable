@echo off
setlocal EnableExtensions
title DeepSeek Harness - Instance Manager

rem ============================================================
rem  DeepSeek Harness Portable - Instance Manager launcher
rem  Runs instance-manager.mjs with the embedded Node.js.
rem  The manager creates/edits/start/stops dsh instances, each
rem  with its own data directory (DSH_HOME) and port.
rem  Pass --cli list|start <name>|stop <name> for one-shot use.
rem ============================================================

chcp 65001 >nul 2>&1

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"

set "NODE_EXE=%APP_DIR%\runtime\node\node.exe"
set "MGR_SCRIPT=%APP_DIR%\instance-manager.mjs"

if not exist "%NODE_EXE%" (
  echo [ERROR] Embedded Node.js runtime not found: "%NODE_EXE%"
  pause
  exit /b 1
)
if not exist "%MGR_SCRIPT%" (
  echo [ERROR] instance-manager.mjs not found: "%MGR_SCRIPT%"
  pause
  exit /b 1
)

cd /d "%APP_DIR%"
"%NODE_EXE%" "%MGR_SCRIPT%" %*
set "EXIT_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %EXIT_CODE%
