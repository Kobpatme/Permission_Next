@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-nas-bridge-startup.ps1"
if errorlevel 1 pause
