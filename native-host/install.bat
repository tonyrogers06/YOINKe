@echo off
setlocal EnableDelayedExpansion

echo.
echo  ============================================================
echo   YOINKe -- Automated 1-Click Installer
echo  ============================================================
echo.

:: ── Determine directories ─────────────────────────────────────────────────
set "HOST_DIR=%~dp0"
if "!HOST_DIR:~-1!" == "\" set "HOST_DIR=!HOST_DIR:~0,-1!"
set "BIN_DIR=!HOST_DIR!\bin"
set "VENV_DIR=!HOST_DIR!\.venv"
if not exist "!BIN_DIR!" mkdir "!BIN_DIR!"

set "LAUNCH_BAT=!HOST_DIR!\launch_host.bat"
set "APP_BAT=!HOST_DIR!\launch_app.bat"
set "MANIFEST=!HOST_DIR!\manifest_host.json"

:: ── 1. Detect or auto-install Python ──────────────────────────────────────
echo [1/7] Checking Python 3.8+...
where python >nul 2>&1
if %errorlevel% neq 0 (
    where python3 >nul 2>&1
    if %errorlevel% neq 0 (
        echo     Python not found. Attempting automatic install via winget...
        where winget >nul 2>&1
        if %errorlevel% neq 0 (
            echo [ERROR] Python and winget not found. Please install Python 3.10+ from https://python.org
            pause & exit /b 1
        )
        winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
        if %errorlevel% neq 0 (
            echo [ERROR] Automatic Python installation failed. Please install Python manually.
            pause & exit /b 1
        )
        set "PATH=%LOCALAPPDATA%\Programs\Python\Python312\;%LOCALAPPDATA%\Programs\Python\Python312\Scripts\;%PATH%"
    ) else (
        set "PYTHON=python3"
    )
)
if not defined PYTHON set "PYTHON=python"
for /f "tokens=*" %%i in ('where !PYTHON!') do set "SYS_PYTHON=%%i" & goto :found_python
:found_python
echo [OK] System Python: !SYS_PYTHON!

:: ── 2. Create isolated Virtual Environment (.venv) ────────────────────────
echo [2/7] Setting up isolated virtual environment (.venv)...
if not exist "!VENV_DIR!\Scripts\python.exe" (
    "!SYS_PYTHON!" -m venv "!VENV_DIR!"
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to create virtual environment.
        pause & exit /b 1
    )
)
set "VENV_PYTHON=!VENV_DIR!\Scripts\python.exe"
set "VENV_PYTHONW=!VENV_DIR!\Scripts\pythonw.exe"
if not exist "!VENV_PYTHONW!" set "VENV_PYTHONW=!VENV_PYTHON!"
echo [OK] Venv ready: !VENV_DIR!

:: ── 3. Install Python dependencies inside .venv ───────────────────────────
echo [3/7] Installing dependencies inside .venv...
"!VENV_PYTHON!" -c "import webview" >nul 2>&1
if %errorlevel% neq 0 (
    "!VENV_PYTHON!" -m pip install -q --upgrade pip
    "!VENV_PYTHON!" -m pip install -q -r "!HOST_DIR!\requirements.txt"
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install Python dependencies inside .venv.
        pause & exit /b 1
    )
)
"!VENV_PYTHON!" -c "import webview" >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] pywebview import verification failed.
    pause & exit /b 1
)
echo [OK] Dependencies ready inside .venv

:: ── 4. Auto-download ffmpeg.exe & N_m3u8DL-RE.exe into bin\ ───────────────
echo [4/7] Checking ffmpeg.exe & N_m3u8DL-RE.exe...
if not exist "!BIN_DIR!\ffmpeg.exe" (
    if exist "C:\tools\VideoGrabber\ffmpeg.exe" (
        copy /y "C:\tools\VideoGrabber\ffmpeg.exe" "!BIN_DIR!\ffmpeg.exe" >nul
        echo [OK] Copied existing ffmpeg.exe to bin\
    ) else (
        echo     Downloading ffmpeg.exe...
        powershell -NoProfile -Command "$z=Join-Path $env:TEMP 'ffmpeg_vg.zip'; $d=Join-Path $env:TEMP 'ffmpeg_vg_ex'; curl.exe -fSL -o $z 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'; Expand-Archive -Path $z -DestinationPath $d -Force; $exe=Get-ChildItem -Path $d -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1; if($exe){Copy-Item $exe.FullName '!BIN_DIR!\ffmpeg.exe' -Force}; Remove-Item $z,$d -Recurse -Force -ErrorAction SilentlyContinue"
    )
)
if not exist "!BIN_DIR!\ffmpeg.exe" (
    echo [ERROR] Failed to obtain ffmpeg.exe.
    pause & exit /b 1
)

if not exist "!BIN_DIR!\N_m3u8DL-RE.exe" (
    if exist "C:\tools\VideoGrabber\N_m3u8DL-RE.exe" (
        copy /y "C:\tools\VideoGrabber\N_m3u8DL-RE.exe" "!BIN_DIR!\N_m3u8DL-RE.exe" >nul
        echo [OK] Copied existing N_m3u8DL-RE.exe to bin\
    ) else (
        echo     Downloading N_m3u8DL-RE.exe...
        powershell -NoProfile -Command "$rel=Invoke-RestMethod -Uri 'https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest' -Headers @{'User-Agent'='YOINKe'}; $a=$rel.assets | Where-Object {$_.name -match 'win-x64.*\.zip$'} | Select-Object -First 1; $z=Join-Path $env:TEMP 'nm3u8_vg.zip'; $d=Join-Path $env:TEMP 'nm3u8_vg_ex'; curl.exe -fSL -o $z $a.browser_download_url; Expand-Archive -Path $z -DestinationPath $d -Force; $exe=Get-ChildItem -Path $d -Recurse -Filter 'N_m3u8DL-RE.exe' | Select-Object -First 1; if($exe){Copy-Item $exe.FullName '!BIN_DIR!\N_m3u8DL-RE.exe' -Force}; Remove-Item $z,$d -Recurse -Force -ErrorAction SilentlyContinue"
    )
)
if not exist "!BIN_DIR!\N_m3u8DL-RE.exe" (
    echo [ERROR] Failed to obtain N_m3u8DL-RE.exe.
    pause & exit /b 1
)
echo [OK] Media engines ready in bin\

:: ── 5. Create launchers using .venv ───────────────────────────────────────
echo [5/7] Creating launchers...
(
  echo @echo off
  echo cd /d "!HOST_DIR!"
  echo "!VENV_PYTHON!" "!HOST_DIR!\host.py"
) > "!LAUNCH_BAT!"

(
  echo @echo off
  echo cd /d "!HOST_DIR!"
  echo start "" "!VENV_PYTHONW!" "!HOST_DIR!\gui_app.py"
) > "!APP_BAT!"
echo [OK] Launchers created

:: ── 6. Extension ID setup & Registry registration ─────────────────────────
echo.
echo [6/7] Extension ID setup
echo   Load the "extension\" folder in chrome://extensions (Developer Mode),
echo   then copy the Extension ID shown on the YOINKe card.
echo.
set /p EXT_ID="  Paste your Extension ID here (or press Enter to keep current): "
if "!EXT_ID!" == "" (
    for /f "tokens=2 delims=/" %%A in ('findstr /i "chrome-extension://" "!MANIFEST!" 2^>nul') do set "EXT_ID=%%A"
)
if "!EXT_ID!" == "" set "EXT_ID=PLACEHOLDER_EXTENSION_ID"

(
  echo {
  echo   "name": "com.videograbber.host",
  echo   "description": "YOINKe Native Messaging Host",
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

:: ── 7. Create Desktop Shortcut ────────────────────────────────────────────
echo [7/7] Creating Desktop shortcut...
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\YOINKe.lnk'); $s.TargetPath = '!VENV_PYTHONW!'; $s.Arguments = '\"!HOST_DIR!\gui_app.py\"'; $s.WorkingDirectory = '!HOST_DIR!'; $s.IconLocation = '!HOST_DIR!\icon.ico'; $s.WindowStyle = 1; $s.Save()" >nul 2>&1
echo [OK] Desktop shortcut created: YOINKe

echo.
echo  ============================================================
echo   YOINKe Installation Complete!
echo  ============================================================
echo.
pause
