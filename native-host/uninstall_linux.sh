#!/usr/bin/env bash
echo "Uninstalling YOINKe Native Messaging Host..."

TARGETS=(
  "$HOME/.config/google-chrome/NativeMessagingHosts/com.videograbber.host.json"
  "$HOME/.config/chromium/NativeMessagingHosts/com.videograbber.host.json"
  "$HOME/.config/microsoft-edge/NativeMessagingHosts/com.videograbber.host.json"
  "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.videograbber.host.json"
  "$HOME/.config/opera/NativeMessagingHosts/com.videograbber.host.json"
  "$HOME/.local/share/applications/yoinke.desktop"
)

for f in "${TARGETS[@]}"; do
  rm -f "$f"
done

echo "[OK] YOINKe unregistered from all browsers and app menu."
