# PR-AICHATBOT (LLM8850 + Waveshare + wm8960)

This fork runs a local voice chatbot on Raspberry Pi with:
- `LLM8850` for local LLM/ASR/TTS services
- `wm8960` audio HAT for speaker + microphone
- `Waveshare` GPIO button as push-to-talk
- Optional USB arcade/gamepad button input

The Whisplay LCD/button stack is removed from runtime in this fork.

## Hardware Assumptions

- Raspberry Pi (recommended Pi 5)
- LLM8850 AI accelerator
- wm8960 audio HAT
- Waveshare dual HAT button wired to GPIO (default BCM `17`, physical pin `11`)

## Install

```bash
git clone <your-fork-url>
cd PR-AICHATBOT
bash install_dependencies.sh
source ~/.bashrc
cp .env.template .env
```

## Required `.env` (offline/local example)

```bash
ASR_SERVER=llm8850whisper
LLM_SERVER=llm8850
TTS_SERVER=llm8850melotts

LLM8850_LLM_HOST=http://localhost:8000
LLM8850_WHISPER_HOST=http://localhost:8801
LLM8850_MELOTTS_HOST=http://localhost:8802

# Audio routing (override when needed)
# ALSA_OUTPUT_DEVICE=hw:1,0
# ALSA_INPUT_DEVICE=default

# Waveshare GPIO button input
# WAVESHARE_BUTTON_GPIO=17
# BUTTON_GPIO_ACTIVE_LOW=true

# Optional USB gamepad/arcade button listener
# GAMEPAD_LISTENER_ENABLED=true
# GAMEPAD_BUTTON_CODES=304,305,307,308
```

## Build and Run

```bash
bash build.sh
bash run_chatbot.sh
```

## Run as service

```bash
sudo bash startup.sh
```

## Cleanup old pre-fork install

If your Pi previously ran the Whisplay-based install:

```bash
bash cleanup_legacy_install.sh
```

Optional: pass legacy repo path if it was not `~/whisplay-ai-chatbot`:

```bash
bash cleanup_legacy_install.sh /path/to/old/repo
```

Then recreate the service from this fork:

```bash
sudo bash startup.sh
```

## Controls

- Press and hold mapped button (GPIO or gamepad code) to record.
- Release to stop recording and trigger ASR.
- Wake word mode still works if enabled in `.env`.

## Notes

- Battery display from PiSugar manager is optional; if unavailable it fails gracefully.
- Camera-on-display mode from Whisplay is not supported in this fork.
