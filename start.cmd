@echo off
chcp 65001 >nul
if exist "%~dp0创意工坊.exe" goto desktop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0src\launch.ps1"
exit /b %errorlevel%
:desktop
start "" "%~dp0创意工坊.exe"
