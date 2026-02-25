#!/bin/bash
set -euo pipefail

REPO_DIR=$(cd "$(dirname "$0")" && pwd)
LEGACY_DIR_DEFAULT="$HOME/whisplay-ai-chatbot"
LEGACY_DIR="${1:-$LEGACY_DIR_DEFAULT}"

echo "[Cleanup] Repo dir: $REPO_DIR"
echo "[Cleanup] Legacy dir: $LEGACY_DIR"

if systemctl list-unit-files | grep -q '^chatbot.service'; then
  echo "[Cleanup] Stopping chatbot.service"
  sudo systemctl stop chatbot.service || true
fi

echo "[Cleanup] Killing stale processes"
pkill -f "python3 chatbot-ui.py" || true
pkill -f "python3 .*whisplay.py" || true
pkill -f "node .*dist/index.js" || true

if [ -f /etc/systemd/system/chatbot.service ]; then
  echo "[Cleanup] Removing old systemd unit"
  sudo rm -f /etc/systemd/system/chatbot.service
  sudo systemctl daemon-reload
fi

if [ -f "$LEGACY_DIR/chatbot.log" ]; then
  echo "[Cleanup] Removing legacy log: $LEGACY_DIR/chatbot.log"
  rm -f "$LEGACY_DIR/chatbot.log"
fi

if [ -d "$LEGACY_DIR/dist" ] && [ "$LEGACY_DIR" != "$REPO_DIR" ]; then
  echo "[Cleanup] Removing legacy build output: $LEGACY_DIR/dist"
  rm -rf "$LEGACY_DIR/dist"
fi

echo "[Cleanup] Done. Recreate service with: sudo bash $REPO_DIR/startup.sh"
