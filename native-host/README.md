# VideoGrabber — Setup Guide

## What is this?

VideoGrabber is a **free, open-source** Chromium browser extension that detects and downloads videos from any webpage — HLS streams, DASH streams, and direct MP4/WebM files. It uses your **RTX GPU** (NVENC/NVDEC via CUDA) for fast, hardware-accelerated processing.

---

## Requirements

| Tool | Purpose | Download |
|---|---|---|
| **Python 3.8+** | Runs the native host | [python.org](https://www.python.org/downloads/) |
| **ffmpeg.exe** (NVENC build) | Video muxing + GPU decode | [gyan.dev/ffmpeg/builds](https://www.gyan.dev/ffmpeg/builds/) — download `ffmpeg-release-full.7z` |
| **N_m3u8DL-RE.exe** | HLS/DASH parallel segment downloader | [GitHub Releases](https://github.com/nilaoda/N_m3u8DL-RE/releases) — download `N_m3u8DL-RE_v*_win-x64.zip` |

---

## Installation Steps

### Step 1 — Place the tools

Create the folder `C:\tools\VideoGrabber\` and place:
- `ffmpeg.exe` there
- `N_m3u8DL-RE.exe` there

> **Why the NVENC build of ffmpeg?**
> The standard ffmpeg build may not have CUDA/NVENC compiled in. The `gyan.dev` full build includes all hardware encoders.

### Step 2 — Load the Chrome Extension

1. Open Chrome (or Edge / Opera GX / Brave)
2. Navigate to `chrome://extensions`
3. Enable **Developer Mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select the **`extension\`** folder inside this project
6. The VideoGrabber icon appears in your toolbar
7. **Copy the Extension ID** shown on the card (looks like `abcdefghijklmnopabcdefghijklmnop`)

### Step 3 — Run the Installer

1. Double-click **`install.bat`** in the `native-host\` folder
2. When prompted, paste your Extension ID from Step 2
3. The installer registers the native host for Chrome, Edge, Opera GX, and Brave

> If you skip entering the ID during install, edit `manifest_host.json` afterward and replace `PLACEHOLDER_EXTENSION_ID` with your real ID, then restart the browser.

### Step 4 — Test the Connection

Open Chrome DevTools console on any page and run:
```js
chrome.runtime.sendMessage('<your-ext-id>', {type: 'TEST'}, console.log)
```

Or simply: visit any video site, click the VideoGrabber toolbar icon, and try downloading something non-DRM.

---

## GPU Acceleration Details

| Feature | Setting |
|---|---|
| **Hardware decode** | `-hwaccel cuda -hwaccel_output_format cuda` |
| **Mux mode** | `-c copy` (stream copy, no re-encode = fastest) |
| **Parallel segments** | `--thread-count 16` (adjustable in extension Settings) |
| **GPU** | Your RTX (NVDEC decode + NVENC available for re-encode if ever needed) |

> Stream-copy mode means your GPU decodes but we DON'T re-encode — the video is remuxed as-is into an MP4/MKV container. This is instantaneous compared to re-encoding, with zero quality loss.

---

## Changing the Extension ID

If you reinstall the extension, Chrome assigns a new ID. Update it:

1. Edit `native-host\manifest_host.json`
2. Replace the ID in `"allowed_origins": ["chrome-extension://YOUR_ID/"]`
3. Re-run `install.bat` (or the registry is already pointing at the same `manifest_host.json` file, so just saving it is enough)
4. Restart the browser

---

## Troubleshooting

### "Native host not installed" in the popup
- Make sure you ran `install.bat` **after** loading the extension and entering the correct Extension ID
- Check that `launch_host.bat` exists in `native-host\`
- Verify the registry key: press Win+R → `regedit` → navigate to `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.videograbber.host`

### Download starts but no file appears
- Check that `ffmpeg.exe` is at the path shown in Settings
- Open Settings in the popup and verify all paths

### GPU not being used
- Confirm your ffmpeg has CUDA support: open cmd, run `ffmpeg -hwaccels` — should list `cuda`
- Install/update NVIDIA drivers if needed
- Make sure "Use GPU acceleration" is checked in the popup Settings

### HLS quality dropdown shows only "Best available"
- The manifest URL may require cookies/auth headers. The extension tries to fetch it with your session cookies — if the site blocks cross-origin manifest reads, the quality list can't be populated.
- In this case, the full stream URL (default quality) is still downloaded correctly.

---

## File Structure

```
VideoGrabber/
├── extension/          ← Load this in Chrome
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.js
│   │   └── popup.css
│   ├── libs/
│   │   └── hls-parser.js
│   └── icons/
└── native-host/        ← Python companion app
    ├── host.py         ← Chrome communicates with this
    ├── downloader.py   ← ffmpeg / N_m3u8DL-RE runner
    ├── install.bat     ← Run once to register
    ├── uninstall.bat   ← Removes registry entries
    └── README.md       ← This file
```
