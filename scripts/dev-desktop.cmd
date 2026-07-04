@echo off
setlocal
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev-desktop.ps1" %*
exit /b %ERRORLEVEL%
