@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-nas-browser-policy-admin.ps1"
if errorlevel 1 pause
