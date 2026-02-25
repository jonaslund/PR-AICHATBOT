#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

ASR_HOST="${LLM8850_WHISPER_HOST:-http://localhost:8801}"
IN_DEVICE="${ALSA_INPUT_DEVICE:-default}"
DURATION="${1:-4}"
WAV_FILE="/tmp/llm8850_asr_test_$(date +%s).wav"

echo "[ASR] Host: $ASR_HOST"
echo "[ASR] Input device: $IN_DEVICE"
echo "[ASR] Recording ${DURATION}s to $WAV_FILE"

sox -q -t alsa "$IN_DEVICE" -t wav -c 1 -r 16000 "$WAV_FILE" trim 0 "$DURATION"

base64_audio=$(base64 -w0 "$WAV_FILE")
payload=$(python3 - <<'PY' "$WAV_FILE" "$base64_audio"
import json,sys
print(json.dumps({"filePath": sys.argv[1], "base64": sys.argv[2]}))
PY
)

resp=$(curl -fsS -X POST "$ASR_HOST/recognize" \
  -H "Content-Type: application/json" \
  -d "$payload")

text=$(python3 -c 'import json,sys; data=json.loads(sys.argv[1]); print(data.get("recognition", ""))' "$resp")

echo "[ASR] Transcript: $text"
