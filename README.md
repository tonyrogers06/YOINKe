# YOINKe

A free, lightweight Chromium extension + desktop downloader (`pywebview` + SQLite) that detects and downloads HLS, DASH, and direct videos from any webpage.

**Supports:** Chrome · Edge · Opera GX · Brave (Windows & Ubuntu/Linux)

---

## Features

- 🔍 **Auto-detects** HLS (`.m3u8`), DASH (`.mpd`), MP4, WebM, and MKV streams as you browse
- ★ **Active Video Matching** — highlights the video currently playing on screen
- 🎚️ **Quality & Language Selection** — choose resolution and audio track before downloading
- ✏️ **Custom Video Naming** — rename before starting the download
- ⚡ **16-Thread Parallel Downloading** — powered by `N_m3u8DL-RE` + `ffmpeg` stream copy (`-c copy`, zero re-encoding)
- 🖥️ **Persistent Desktop App** — lightweight `pywebview` UI with SQLite history, Dark/Light/OLED themes, 6 accent colors, Task Inspector, and 1-click GitHub updates
- 🔒 **Clean & Local** — zero telemetry, isolated `.venv` + temp staging so incomplete files never clutter your Downloads folder

---

## Automated 1-Click Installation

### Windows
1. Run **`native-host\install.bat`** (or use **`YOINKe-Setup.exe`** from GitHub Releases).
   - Automatically checks/installs Python (via `winget` if needed)
   - Creates an isolated virtual environment (`native-host\.venv`) so your global Python is untouched
   - Automatically downloads `ffmpeg.exe` and `N_m3u8DL-RE.exe` into `native-host\bin\`
   - Registers the Native Messaging Host for Chrome, Edge, Opera GX, and Brave
   - Creates a **YOINKe** Desktop shortcut
2. Open `chrome://extensions` → enable **Developer Mode** → **Load unpacked** → select the **`extension\`** folder.

### Ubuntu / Linux
```bash
chmod +x native-host/install_linux.sh
./native-host/install_linux.sh
```
Then load **`extension/`** in Chrome/Chromium/Edge/Brave via `chrome://extensions`.

---

## Building a Windows `.exe` Release

Run from PowerShell:
```powershell
.\build_windows_release.ps1
```
This generates `dist\YOINKe-Windows.zip` and `dist\YOINKe-Setup.exe` (using Windows' built-in `.NET` compiler).

---

## Credits & Open-Source Libraries

YOINKe is built on top of these open-source projects:

- **[N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE)** by nilaoda — Multi-threaded HLS/DASH stream downloader
- **[FFmpeg](https://ffmpeg.org/)** ([gyan.dev Windows builds](https://www.gyan.dev/ffmpeg/builds/)) — Media remuxing and container processing
- **[pywebview](https://github.com/r0x0r/pywebview)** — Lightweight native WebView2 / WebKitGTK desktop window
- **[Lucide Icons](https://lucide.dev/)** — Crisp open-source SVG icon set
- **[Cat-Catch](https://github.com/xifangczy/cat-catch)** — Reference for Chromium MV3 request-header capture and `N_m3u8DL-RE` workflow

