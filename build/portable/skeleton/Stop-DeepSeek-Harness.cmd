@echo off
setlocal EnableExtensions
title Stop DeepSeek Harness Portable

rem Stops the DeepSeek Harness server listening on the given port (default 3080).

set "PORT=3080"
if not "%~1"=="" set "PORT=%~1"

echo Stopping DeepSeek Harness on port %PORT% ...
set "FOUND=0"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  if not "%%P"=="0" (
    taskkill /PID %%P /F >nul 2>&1 && echo Killed PID %%P
    set "FOUND=1"
  )
)
if "%FOUND%"=="0" echo Nothing listening on port %PORT%.
echo Done.
