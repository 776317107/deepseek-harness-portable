@echo off
setlocal EnableExtensions
title DeepSeek Harness Portable

rem ============================================================
rem  DeepSeek Harness Portable - launcher
rem  Bundles Node.js + @deepseek-ai/dsh. All data stays local:
rem  DSH_HOME is forced to <app>\data, so copying this folder
rem  moves your config, plugins and sessions along with it.
rem ============================================================

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"

rem ---- user data root: default .\data, overridable via DSH_HOME env ----
if not defined DSH_HOME set "DSH_HOME=%APP_DIR%\data"
if "%DSH_HOME%"=="" set "DSH_HOME=%APP_DIR%\data"
if not exist "%DSH_HOME%" mkdir "%DSH_HOME%"

rem ---- skills home: keep inside the app folder (portable) ----
set "DSH_AGENTS_HOME=%DSH_HOME%\.agents"
if not exist "%DSH_AGENTS_HOME%" mkdir "%DSH_AGENTS_HOME%"

rem ---- embedded Node.js runtime ----
set "NODE_EXE=%APP_DIR%\runtime\node\node.exe"
if not exist "%NODE_EXE%" (
  echo [ERROR] Embedded Node.js runtime not found: "%NODE_EXE%"
  pause
  exit /b 1
)

rem ---- dsh CLI entry ----
set "DSH_BIN=%APP_DIR%\app\node_modules\@deepseek-ai\dsh\lib\bin.js"
if not exist "%DSH_BIN%" (
  echo [ERROR] dsh package not found: "%DSH_BIN%"
  pause
  exit /b 1
)

rem ---- make bundled tools (node, npm, npx, pnpm) available ----
set "PATH=%APP_DIR%\runtime\node;%APP_DIR%\runtime\tools\node_modules\.bin;%PATH%"

rem ---- keep pnpm home/store inside the app folder (portable) ----
set "PNPM_HOME=%DSH_HOME%\.pnpm-home"
set "PNPM_STORE_DIR=%DSH_HOME%\.pnpm-store"

rem ---- privacy: disable session telemetry unless explicitly overridden ----
if not defined DSH_TELEMETRY_DISABLED set "DSH_TELEMETRY_DISABLED=1"

rem ---- work from the app folder so the workspace travels too ----
cd /d "%APP_DIR%"

rem ---- default action: boot the web UI (http://127.0.0.1:3080) ----
if "%~1"=="" (
  echo Starting DeepSeek Harness Web UI ...
  echo   Home : %DSH_HOME%
  echo   UI   : http://127.0.0.1:3080
  echo   Stop : close this window or press Ctrl+C
  echo.
  "%NODE_EXE%" "%DSH_BIN%" web
) else (
  "%NODE_EXE%" "%DSH_BIN%" %*
)

set "EXIT_CODE=%ERRORLEVEL%"
exit /b %EXIT_CODE%
