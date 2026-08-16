@echo off
rem Chinese convenience launcher - delegates to Start-DeepSeek-Harness.cmd
call "%~dp0Start-DeepSeek-Harness.cmd" %*
exit /b %ERRORLEVEL%
