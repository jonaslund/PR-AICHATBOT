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

LLM_HOST="${LLM8850_LLM_HOST:-http://localhost:8000}"
PROMPT="${*:-Say hello in one short sentence.}"
TEMP="${LLM8850_LLM_TEMPERATURE:-0.7}"
TOP_K="${LLM8850_LLM_TOP_K:-40}"
MAX_SEC="${LLM_TEST_TIMEOUT_SEC:-90}"

echo "[LLM] Host: $LLM_HOST"
echo "[LLM] Prompt: $PROMPT"

payload=$(python3 - <<'PY' "$PROMPT" "$TEMP" "$TOP_K"
import json,sys
print(json.dumps({
  "prompt": sys.argv[1],
  "temperature": float(sys.argv[2]),
  "top-k": int(float(sys.argv[3]))
}))
PY
)

curl -fsS -X POST "$LLM_HOST/api/generate" \
  -H "Content-Type: application/json" \
  -d "$payload" >/dev/null

echo -n "[LLM] Response: "
start=$(date +%s)
while true; do
  now=$(date +%s)
  elapsed=$((now - start))
  if [ "$elapsed" -gt "$MAX_SEC" ]; then
    echo
    echo "[LLM] Timeout after ${MAX_SEC}s"
    curl -fsS "$LLM_HOST/api/stop" >/dev/null || true
    exit 1
  fi

  resp=$(curl -fsS "$LLM_HOST/api/generate_provider" || true)
  if [ -z "$resp" ]; then
    sleep 0.5
    continue
  fi

  parsed=$(python3 -c '
import json,sys
try:
    data = json.loads(sys.argv[1])
except Exception:
    print("0\t")
    raise SystemExit
resp = data.get("response") or ""
done = 1 if data.get("done") else 0
print(f"{done}\t{resp}")
' "$resp")

  done_flag=${parsed%%$'\t'*}
  chunk=${parsed#*$'\t'}
  if [ -n "$chunk" ]; then
    printf '%s' "$chunk"
  fi

  if [ "$done_flag" = "1" ]; then
    echo
    echo "[LLM] OK"
    exit 0
  fi

  sleep 0.5
done
