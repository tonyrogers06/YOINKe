#!/usr/bin/env bash
set -e

echo "============================================================"
echo "  YOINKe -- Ubuntu / Linux 1-Click Installer"
echo "============================================================"

HOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOST_DIR/bin"
mkdir -p "$BIN_DIR"

# 1. Check Python 3
echo "[1/6] Checking Python 3..."
if ! command -v python3 >/dev/null 2>&1; then
  echo "[ERROR] python3 not found. Install it with: sudo apt update && sudo apt install -y python3 python3-pip"
  exit 1
fi
PYTHON_BIN="$(command -v python3)"
echo "[OK] Python: $PYTHON_BIN"

# 2. Install pywebview + GTK/WebKitGTK renderer
echo "[2/6] Checking pywebview & WebKit2GTK renderer..."
sudo apt-get update -qq
sudo apt-get install -y -qq python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-webkit2-4.1 || \
  sudo apt-get install -y -qq python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-webkit2-4.0

if ! "$PYTHON_BIN" -c "import webview" >/dev/null 2>&1; then
  echo "Installing pywebview..."
  "$PYTHON_BIN" -m pip install --user -r "$HOST_DIR/requirements.txt" || \
    "$PYTHON_BIN" -m pip install --break-system-packages -r "$HOST_DIR/requirements.txt"
fi

if ! "$PYTHON_BIN" -c "import webview, gi; gi.require_version('Gtk', '3.0')" >/dev/null 2>&1; then
  echo "[ERROR] pywebview or GTK/WebKit backend failed verification."
  exit 1
fi
echo "[OK] pywebview + GTK/WebKit renderer ready"

# 3. Ensure ffmpeg & N_m3u8DL-RE (Linux x64)
echo "[3/6] Checking ffmpeg & N_m3u8DL-RE..."
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Installing ffmpeg via apt (may prompt for sudo password)..."
  sudo apt-get update && sudo apt-get install -y ffmpeg
fi

if [ ! -f "$BIN_DIR/N_m3u8DL-RE" ]; then
  echo "Downloading latest N_m3u8DL-RE (linux-x64)..."
  TMP_DIR="$(mktemp -d)"
  DL_URL="$(curl -sL https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest | \
    python3 -c "import sys,json; assets=json.load(sys.stdin).get('assets',[]); print(next((a['browser_download_url'] for a in assets if 'linux-x64' in a['name'] and a['name'].endswith('.tar.gz')), ''))")"
  if [ -n "$DL_URL" ]; then
    curl -sL "$DL_URL" -o "$TMP_DIR/nm3u8.tar.gz"
    tar -xzf "$TMP_DIR/nm3u8.tar.gz" -C "$TMP_DIR"
    FOUND_BIN="$(find "$TMP_DIR" -type f -name 'N_m3u8DL-RE' | head -n1)"
    if [ -n "$FOUND_BIN" ]; then
      cp "$FOUND_BIN" "$BIN_DIR/N_m3u8DL-RE"
      chmod +x "$BIN_DIR/N_m3u8DL-RE"
      echo "[OK] N_m3u8DL-RE installed to $BIN_DIR/N_m3u8DL-RE"
    fi
  else
    echo "[WARN] Could not auto-download N_m3u8DL-RE; place it in $BIN_DIR/N_m3u8DL-RE"
  fi
  rm -rf "$TMP_DIR"
fi

# 4. Create launcher scripts
echo "[4/6] Creating launcher scripts..."
cat > "$HOST_DIR/launch_host.sh" <<EOF
#!/usr/bin/env bash
cd "$HOST_DIR"
exec "$PYTHON_BIN" "$HOST_DIR/host.py"
EOF
chmod +x "$HOST_DIR/launch_host.sh"

cat > "$HOST_DIR/launch_app.sh" <<EOF
#!/usr/bin/env bash
cd "$HOST_DIR"
nohup "$PYTHON_BIN" "$HOST_DIR/gui_app.py" >/dev/null 2>&1 &
EOF
chmod +x "$HOST_DIR/launch_app.sh"

# 5. Native Messaging Host registration
echo "[5/6] Registering Native Messaging Host..."
read -r -p "Paste your Chrome/Edge Extension ID (or press Enter to set later): " EXT_ID
[ -z "$EXT_ID" ] && EXT_ID="PLACEHOLDER_EXTENSION_ID"

MANIFEST_JSON="$HOST_DIR/com.videograbber.host.json"
cat > "$MANIFEST_JSON" <<EOF
{
  "name": "com.videograbber.host",
  "description": "YOINKe Native Messaging Host",
  "path": "$HOST_DIR/launch_host.sh",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF

TARGETS=(
  "$HOME/.config/google-chrome/NativeMessagingHosts"
  "$HOME/.config/chromium/NativeMessagingHosts"
  "$HOME/.config/microsoft-edge/NativeMessagingHosts"
  "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  "$HOME/.config/opera/NativeMessagingHosts"
)

for dir in "${TARGETS[@]}"; do
  mkdir -p "$dir"
  ln -sf "$MANIFEST_JSON" "$dir/com.videograbber.host.json"
done
echo "[OK] Registered for Chrome, Chromium, Edge, Brave, and Opera"

# 6. Desktop entry (.desktop)
echo "[6/6] Creating Ubuntu Desktop App entry..."
mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/yoinke.desktop" <<EOF
[Desktop Entry]
Name=YOINKe
Comment=GPU-Accelerated Video Downloader
Exec=$HOST_DIR/launch_app.sh
Icon=$HOST_DIR/ui/logo.png
Terminal=false
Type=Application
Categories=Network;AudioVideo;
EOF
chmod +x "$HOME/.local/share/applications/yoinke.desktop"

echo ""
echo "============================================================"
echo "  YOINKe installed for Ubuntu!"
echo "  Load the extension/ folder in chrome://extensions"
echo "============================================================"
