@echo off
setlocal EnableDelayedExpansion

echo.
echo  ============================================================
echo   VideoGrabber -- 1-Click Installer
echo  ============================================================
echo.

:: ── Determine script directory ────────────────────────────────────────────
set "HOST_DIR=%~dp0"
if "!HOST_DIR:~-1!" == "\" set "HOST_DIR=!HOST_DIR:~0,-1!"

set "LAUNCH_BAT=!HOST_DIR!\launch_host.bat"
set "APP_BAT=!HOST_DIR!\launch_app.bat"
set "MANIFEST=!HOST_DIR!\manifest_host.json"

:: ── 1. Detect Python ──────────────────────────────────────────────────────
echo [1/6] Detecting Python...
where python >nul 2>&1
if %errorlevel% neq 0 (
    where python3 >nul 2>&1
    if %errorlevel% neq 0 (
        echo [ERROR] Python not found. Please install Python 3.8+ from https://python.org
        pause & exit /b 1
    )
    set "PYTHON=python3"
) else (
    set "PYTHON=python"
)
for /f "tokens=*" %%i in ('where !PYTHON!') do set "PYTHON_PATH=%%i" & goto :found_python
:found_python
for %%F in ("!PYTHON_PATH!") do set "PYTHON_DIR=%%~dpF"
set "PYTHONW_PATH=!PYTHON_DIR!pythonw.exe"
if not exist "!PYTHONW_PATH!" set "PYTHONW_PATH=!PYTHON_PATH!"
echo [OK] Python found: !PYTHON_PATH!

:: ── 2. Install Python dependencies (pywebview) ────────────────────────────
echo [2/6] Checking Python packages (pywebview)...
"!PYTHON_PATH!" -c "import webview" >nul 2>&1
if %errorlevel% neq 0 (
    echo     Installing pywebview...
    "!PYTHON_PATH!" -m pip install -q -r "!HOST_DIR!\requirements.txt"
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install Python dependencies via pip.
        pause & exit /b 1
    )
)
"!PYTHON_PATH!" -c "import webview" >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] pywebview import verification failed.
    pause & exit /b 1
)
echo [OK] Dependencies ready

:: ── 3. Create launchers ───────────────────────────────────────────────────
echo [3/6] Creating launchers...
(
  echo @echo off
  echo cd /d "!HOST_DIR!"
  echo "!PYTHON_PATH!" "!HOST_DIR!\host.py"
) > "!LAUNCH_BAT!"

(
  echo @echo off
  echo cd /d "!HOST_DIR!"
  echo start "" "!PYTHONW_PATH!" "!HOST_DIR!\gui_app.py"
) > "!APP_BAT!"
echo [OK] Launchers created

:: ── 4. Extension ID setup ─────────────────────────────────────────────────
echo.
echo [4/6] Extension ID setup
echo   Load the "extension\" folder in chrome://extensions (Developer Mode),
echo   then copy the Extension ID shown on the VideoGrabber card.
echo.
set /p EXT_ID="  Paste your Extension ID here (or press Enter to keep current): "
if "!EXT_ID!" == "" (
    for /f "tokens=2 delims=/" %%A in ('findstr /i "chrome-extension://" "!MANIFEST!" 2^>nul') do set "EXT_ID=%%A"
)
if "!EXT_ID!" == "" set "EXT_ID=PLACEHOLDER_EXTENSION_ID"

:: ── 5. Write manifest_host.json & register browsers ──────────────────────
echo [5/6] Registering Native Messaging Host for Chromium browsers...
(
  echo {
  echo   "name": "com.videograbber.host",
  echo   "description": "VideoGrabber Native Messaging Host",
  echo   "path": "!LAUNCH_BAT:\=\\!",
  echo   "type": "stdio",
  echo   "allowed_origins": [
  echo     "chrome-extension://!EXT_ID!/"
  echo   ]
  echo }
) > "!MANIFEST!"

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.videograbber.host" /ve /t REG_SZ /d "!MANIFEST!" /f >nul 2>&1
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.videograbber.host" /ve /t REG_SZ /d "!MANIFEST!" /f >nul 2>&1
reg add "HKCU\Software\Opera Software\NativeMessagingHosts\com.videograbber.host" /ve /t REG_SZ /d "!MANIFEST!" /f >nul 2>&1
reg add "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.videograbber.host" /ve /t REG_SZ /d "!MANIFEST!" /f >nul 2>&1
echo [OK] Registered for Chrome, Edge, Opera GX, and Brave

:: ── 6. Create Desktop Shortcut ────────────────────────────────────────────
echo [6/6] Creating Desktop shortcut...
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\YOINKe.lnk'); $s.TargetPath = '!PYTHONW_PATH!'; $s.Arguments = '\"!HOST_DIR!\gui_app.py\"'; $s.WorkingDirectory = '!HOST_DIR!'; $s.IconLocation = '!HOST_DIR!\icon.ico'; $s.WindowStyle = 1; $s.Save()" >nul 2>&1
echo [OK] Desktop shortcut created: YOINKe

echo.
echo  ============================================================
echo   Installation Complete!
echo  ============================================================
echo.
pause
