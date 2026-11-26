# 🎬 VideoGrabber

A free, GPU-accelerated Chromium extension + native host that detects and downloads videos from any webpage.

**Supports:** Chrome · Edge · Opera GX · Brave (any Chromium-based browser)

## Features

- 🔍 **Auto-detects** HLS streams, DASH streams, MP4, WebM, and more — passively, as you browse
- 🎚️ **Quality selection** — picks from detected quality variants (1080p / 720p / 480p…)
- 🌐 **Language/audio track selection** — choose your audio language when available
- ⚡ **GPU-accelerated** — uses your RTX (NVDEC decode + NVENC encode via CUDA)
- ⬇️ **Parallel segment download** — 16 threads via N_m3u8DL-RE for fast HLS/DASH
- 🎨 **Dark/light theme** — modern popup UI
- 🔒 **DRM detection** — DRM-protected streams are labelled (not downloaded)
- ✅ **100% local** — no servers, no telemetry, no subscriptions

## Quick Start

1. See [`native-host/README.md`](native-host/README.md) for setup instructions
2. Load the `extension/` folder in Chrome via `chrome://extensions` → Load Unpacked
3. Run `native-host/install.bat` once to register the native host
4. Browse any site, click the 🎬 icon in your toolbar

## Project Structure

```
VideoGrabber/
├── extension/              ← Chrome extension (load this folder)
│   ├── manifest.json
│   ├── background.js       ← Network sniffing + native messaging bridge
│   ├── content.js          ← DOM scanner + EME observer
│   ├── popup/
│   │   ├── popup.html      ← GUI
│   │   ├── popup.js        ← Logic
│   │   └── popup.css       ← Dark/light theme
│   ├── libs/
│   │   └── hls-parser.js   ← HLS + DASH manifest parser
│   └── icons/
└── native-host/            ← Python companion app
    ├── host.py             ← Native messaging entry point
    ├── downloader.py       ← ffmpeg / N_m3u8DL-RE GPU runner
    ├── install.bat         ← One-click installer
    ├── uninstall.bat       ← Removes registry keys
    ├── requirements.txt    ← pip dependencies
    └── README.md           ← Full setup guide
```

## Tools Required

| Tool | Where to get |
|---|---|
| `ffmpeg.exe` (NVENC build) | [gyan.dev/ffmpeg/builds](https://www.gyan.dev/ffmpeg/builds/) |
| `N_m3u8DL-RE.exe` | [github.com/nilaoda/N_m3u8DL-RE/releases](https://github.com/nilaoda/N_m3u8DL-RE/releases) |
| Python 3.8+ | [python.org](https://www.python.org/downloads/) |

Place `ffmpeg.exe` and `N_m3u8DL-RE.exe` in `C:\tools\VideoGrabber\` (or configure custom paths in extension Settings).
