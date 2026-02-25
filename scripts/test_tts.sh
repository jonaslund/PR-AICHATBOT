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

TTS_HOST="${LLM8850_MELOTTS_HOST:-http://localhost:8802}"
OUT_DEVICE="${ALSA_OUTPUT_DEVICE:-hw:${SOUND_CARD_INDEX:-1},0}"
PLAY_DEVICE="$OUT_DEVICE"
if [[ "$PLAY_DEVICE" == hw:* ]]; then
  PLAY_DEVICE="plughw:${PLAY_DEVICE#hw:}"
fi
TEXT="${*:-Hello from LLM8850 MeloTTS. This is a speaker test.}"
OUT_FILE="/tmp/llm8850_tts_test_$(date +%s).wav"
OUT_FILE_STEREO="/tmp/llm8850_tts_test_stereo_$(date +%s).wav"

json_payload=$(python3 - <<'PY' "$TEXT"
import json,sys
print(json.dumps({"sentence": sys.argv[1], "base64": True}))
PY
)

echo "[TTS] Host: $TTS_HOST"
echo "[TTS] Output device: $OUT_DEVICE"
echo "[TTS] Play device: $PLAY_DEVICE"

resp=$(curl -fsS -X POST "$TTS_HOST/synthesize" \
  -H "Content-Type: application/json" \
  -d "$json_payload")

printf '%s' "$resp" | python3 -c '
import json,base64,sys
resp = json.loads(sys.stdin.read())
out = sys.argv[1]
if not resp.get("success"):
    raise SystemExit(f"TTS failed: {resp}")
b64 = resp.get("base64")
if not b64:
    raise SystemExit("TTS response missing base64 audio")
with open(out, "wb") as f:
    f.write(base64.b64decode(b64))
print(out)
' "$OUT_FILE"

echo "[TTS] Converting to stereo PCM for playback..."
sox "$OUT_FILE" -c 2 -r 44100 "$OUT_FILE_STEREO"
echo "[TTS] Playing: $OUT_FILE_STEREO"
aplay -D "$PLAY_DEVICE" "$OUT_FILE_STEREO"
echo "[TTS] OK"
