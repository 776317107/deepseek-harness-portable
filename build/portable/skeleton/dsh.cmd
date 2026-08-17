@echo off
setlocal EnableExtensions
title dsh - DeepSeek Harness Portable

rem Convenience CLI entry: forwards all arguments to the bundled dsh.
rem Examples:
rem   dsh web                                  boot the Web UI
rem   dsh --profile headless "run the tests"   answer one task
rem   dsh plugin --profile web add <package>   install a plugin

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"

if not defined DSH_HOME set "DSH_HOME=%APP_DIR%\data"
if "%DSH_HOME%"=="" set "DSH_HOME=%APP_DIR%\data"
if not exist "%DSH_HOME%" mkdir "%DSH_HOME%"

set "DSH_AGENTS_HOME=%DSH_HOME%\.agents"
if not exist "%DSH_AGENTS_HOME%" mkdir "%DSH_AGENTS_HOME%"

set "NODE_EXE=%APP_DIR%\runtime\node\node.exe"
set "DSH_BIN=%APP_DIR%\app\node_modules\@deepseek-ai\dsh\lib\bin.js"

if not exist "%NODE_EXE%" (
  echo [ERROR] Embedded Node.js runtime not found: "%NODE_EXE%"
  exit /b 1
)
if not exist "%DSH_BIN%" (
  echo [ERROR] dsh package not found: "%DSH_BIN%"
  exit /b 1
)

set "PATH=%APP_DIR%\runtime\node;%APP_DIR%\runtime\tools\node_modules\.bin;%PATH%"
set "PNPM_HOME=%DSH_HOME%\.pnpm-home"
set "PNPM_STORE_DIR=%DSH_HOME%\.pnpm-store"
if not defined DSH_TELEMETRY_DISABLED set "DSH_TELEMETRY_DISABLED=1"

cd /d "%APP_DIR%"
"%NODE_EXE%" "%DSH_BIN%" %*
exit /b %ERRORLEVEL%
