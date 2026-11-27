@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Instalando agente de impresion Kraken ===
set PY=
where py >nul 2>nul && set PY=py
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY (
  echo No encontre Python. Instalalo desde https://www.python.org/downloads/
  echo marcando "Add python.exe to PATH" y vuelve a correr este archivo.
  pause
  exit /b 1
)
%PY% -m pip install --upgrade pip
%PY% -m pip install -r requirements.txt
if errorlevel 1 (
  echo Error instalando dependencias.
  pause
  exit /b 1
)
if not exist config.json copy config.ejemplo.json config.json >nul
for /f "usebackq delims=" %%i in (`%PY% -c "import sys;print(sys.executable.replace('python.exe','pythonw.exe'))"`) do set PYW=%%i
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\Agente Kraken.lnk');$s.TargetPath='%PYW%';$s.Arguments='\"%~dp0agente_kraken.py\"';$s.WorkingDirectory='%~dp0';$s.Save()"
echo.
echo Listo. El agente arrancara solo cada vez que prendas la laptop.
echo  1) Abre config.json y pega "servidor" y "token".
echo  2) Prueba la Zebra con probar_guia.bat
echo  3) Arrancalo ahora con iniciar_agente.bat
pause
