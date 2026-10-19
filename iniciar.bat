@echo off
title Rifa - servidor local
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
    python servidor.py
) else (
    py servidor.py
)

echo.
echo El servidor se detuvo. Los datos quedaron guardados en rifa.db
pause
