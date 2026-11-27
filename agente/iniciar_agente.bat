@echo off
start "" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Agente Kraken.lnk"
echo Agente Kraken iniciado en segundo plano. Su actividad queda en agente.log
timeout /t 4 >nul
