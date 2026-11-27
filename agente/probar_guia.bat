@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PY=python
where py >nul 2>nul && set PY=py
set /p PDF=Arrastra aqui el PDF de la guia y presiona Enter: 
%PY% agente_kraken.py --prueba %PDF%
pause
