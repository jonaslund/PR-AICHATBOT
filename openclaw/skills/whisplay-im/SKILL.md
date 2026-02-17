---
name: whisplay-im
description: HTTP bridge in Whisplay device for IM-style chat.
homepage: https://github.com/PiSugar/whisplay-ai-chatbot
metadata:
  {
    "openclaw": {
      "emoji": "🤖",
      "os": ["linux", "darwin"],
      "requires": { "bins": ["curl"] }
    }
  }
---

# whisplay-im Bridge

## Overview

Use `whisplay-im` to connect OpenClaw to a Whisplay device as a pure IM bridge.
The device pushes ASR text into the bridge. OpenClaw polls for new messages and
sends replies back for TTS playback.

## Inputs to collect

- Bridge base URL (host/port)
- Auth token for `Authorization: Bearer <token>`
- Optional `waitSec` for long-polling

## Actions

### Send device ASR text (inbox)

```bash
curl -X POST \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"message":"hello","messages":[{"role":"user","content":"hello"}]}' \
  http://<device-host>:18888/whisplay-im/inbox
```

### Poll for a new message

```bash
curl -X GET \
  -H "Authorization: Bearer <token>" \
  "http://<device-host>:18888/whisplay-im/poll?waitSec=30"
```

### Send reply to device

```bash
curl -X POST \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"reply":"Hello from OpenClaw"}' \
  http://<device-host>:18888/whisplay-im/send
```

## Notes

- `messages` is optional; use it for context routing.
- `poll` returns an empty payload if no messages are available.

## Ideas to try

- Use long-poll (`waitSec`) to reduce CPU usage.
- Map OpenClaw sessions to different devices by token/host.
