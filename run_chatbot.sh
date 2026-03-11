#!/bin/bash
# Set working directory
export NVM_DIR="/home/pi/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

# Find the sound card index for wm8960 sound card
card_index=$(awk '/wm8960/ {print $1}' /proc/asound/cards | head -n1)
# Default to 1 if not found
if [ -z "$card_index" ]; then
  card_index=1
fi
echo "Using sound card index: $card_index"

# Output current environment information (for debugging)
echo "===== Start time: $(date) =====" 
echo "Current user: $(whoami)" 
echo "Working directory: $(pwd)" 
working_dir=$(pwd)
echo "PATH: $PATH" 
echo "Python version: $(python3 --version)" 
echo "Node version: $(node --version)"
sleep 5

# Start the service
echo "Starting Node.js application..."
cd $working_dir

get_env_value() {
  if grep -Eq "^[[:space:]]*$1[[:space:]]*=" .env; then
    val=$(grep -E "^[[:space:]]*$1[[:space:]]*=" .env | tail -n1 | cut -d'=' -f2-)
    # trim whitespace and surrounding quotes
    echo "$(echo "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
  else
    echo ""
  fi
}

# load .env variables, exclude comments and empty lines
# check if .env file exists
initial_volume_level=114
alsa_volume_control="Speaker"
serve_ollama=false
alsa_output_device="hw:$card_index,0"
alsa_input_device="default"
waveshare_button_gpiochip="gpiochip0"
waveshare_button_line="17"
waveshare_button_gpio="17"
button_gpio_active_low="true"
button_gpio_poll_interval_ms="20"
gamepad_listener_enabled="true"
gamepad_scan_interval_ms="5000"
gamepad_button_codes="304,305,307,308"
gamepad_debug="false"
gamepad_event_record_size=""
if [ -f ".env" ]; then
  # Load only SERVE_OLLAMA from .env (ignore comments/other vars)
  SERVE_OLLAMA=$(get_env_value "SERVE_OLLAMA")
  [ -n "$SERVE_OLLAMA" ] && export SERVE_OLLAMA
  
  CUSTOM_FONT_PATH=$(get_env_value "CUSTOM_FONT_PATH")
  [ -n "$CUSTOM_FONT_PATH" ] && export CUSTOM_FONT_PATH

  INITIAL_VOLUME_LEVEL=$(get_env_value "INITIAL_VOLUME_LEVEL")
  [ -n "$INITIAL_VOLUME_LEVEL" ] && export INITIAL_VOLUME_LEVEL

  ALSA_VOLUME_CONTROL=$(get_env_value "ALSA_VOLUME_CONTROL")
  [ -n "$ALSA_VOLUME_CONTROL" ] && alsa_volume_control=$ALSA_VOLUME_CONTROL

  WHISPER_MODEL_SIZE=$(get_env_value "WHISPER_MODEL_SIZE")
  [ -n "$WHISPER_MODEL_SIZE" ] && export WHISPER_MODEL_SIZE

  FASTER_WHISPER_MODEL_SIZE=$(get_env_value "FASTER_WHISPER_MODEL_SIZE")
  [ -n "$FASTER_WHISPER_MODEL_SIZE" ] && export FASTER_WHISPER_MODEL_SIZE

  ALSA_OUTPUT_DEVICE=$(get_env_value "ALSA_OUTPUT_DEVICE")
  [ -n "$ALSA_OUTPUT_DEVICE" ] && alsa_output_device=$ALSA_OUTPUT_DEVICE

  ALSA_INPUT_DEVICE=$(get_env_value "ALSA_INPUT_DEVICE")
  [ -n "$ALSA_INPUT_DEVICE" ] && alsa_input_device=$ALSA_INPUT_DEVICE

  WAVESHARE_BUTTON_GPIOCHIP=$(get_env_value "WAVESHARE_BUTTON_GPIOCHIP")
  [ -n "$WAVESHARE_BUTTON_GPIOCHIP" ] && waveshare_button_gpiochip=$WAVESHARE_BUTTON_GPIOCHIP

  WAVESHARE_BUTTON_LINE=$(get_env_value "WAVESHARE_BUTTON_LINE")
  [ -n "$WAVESHARE_BUTTON_LINE" ] && waveshare_button_line=$WAVESHARE_BUTTON_LINE

  WAVESHARE_BUTTON_GPIO=$(get_env_value "WAVESHARE_BUTTON_GPIO")
  [ -n "$WAVESHARE_BUTTON_GPIO" ] && waveshare_button_gpio=$WAVESHARE_BUTTON_GPIO

  BUTTON_GPIO_ACTIVE_LOW=$(get_env_value "BUTTON_GPIO_ACTIVE_LOW")
  [ -n "$BUTTON_GPIO_ACTIVE_LOW" ] && button_gpio_active_low=$BUTTON_GPIO_ACTIVE_LOW

  BUTTON_GPIO_POLL_INTERVAL_MS=$(get_env_value "BUTTON_GPIO_POLL_INTERVAL_MS")
  [ -n "$BUTTON_GPIO_POLL_INTERVAL_MS" ] && button_gpio_poll_interval_ms=$BUTTON_GPIO_POLL_INTERVAL_MS

  GAMEPAD_LISTENER_ENABLED=$(get_env_value "GAMEPAD_LISTENER_ENABLED")
  [ -n "$GAMEPAD_LISTENER_ENABLED" ] && gamepad_listener_enabled=$GAMEPAD_LISTENER_ENABLED

  GAMEPAD_SCAN_INTERVAL_MS=$(get_env_value "GAMEPAD_SCAN_INTERVAL_MS")
  [ -n "$GAMEPAD_SCAN_INTERVAL_MS" ] && gamepad_scan_interval_ms=$GAMEPAD_SCAN_INTERVAL_MS

  GAMEPAD_BUTTON_CODES=$(get_env_value "GAMEPAD_BUTTON_CODES")
  [ -n "$GAMEPAD_BUTTON_CODES" ] && gamepad_button_codes=$GAMEPAD_BUTTON_CODES

  GAMEPAD_DEBUG=$(get_env_value "GAMEPAD_DEBUG")
  [ -n "$GAMEPAD_DEBUG" ] && gamepad_debug=$GAMEPAD_DEBUG

  GAMEPAD_EVENT_RECORD_SIZE=$(get_env_value "GAMEPAD_EVENT_RECORD_SIZE")
  [ -n "$GAMEPAD_EVENT_RECORD_SIZE" ] && gamepad_event_record_size=$GAMEPAD_EVENT_RECORD_SIZE

  echo ".env variables loaded."

  # check if SERVE_OLLAMA is set to true
  if [ "$SERVE_OLLAMA" = "true" ]; then
    serve_ollama=true
  fi

  if [ -n "$INITIAL_VOLUME_LEVEL" ]; then
    initial_volume_level=$INITIAL_VOLUME_LEVEL
  fi
else
  echo ".env file not found, please create one based on .env.template."
  exit 1
fi

export ALSA_OUTPUT_DEVICE=$alsa_output_device
export ALSA_INPUT_DEVICE=$alsa_input_device
export WAVESHARE_BUTTON_GPIOCHIP=$waveshare_button_gpiochip
export WAVESHARE_BUTTON_LINE=$waveshare_button_line
export WAVESHARE_BUTTON_GPIO=$waveshare_button_gpio
export BUTTON_GPIO_ACTIVE_LOW=$button_gpio_active_low
export BUTTON_GPIO_POLL_INTERVAL_MS=$button_gpio_poll_interval_ms
export GAMEPAD_LISTENER_ENABLED=$gamepad_listener_enabled
export GAMEPAD_SCAN_INTERVAL_MS=$gamepad_scan_interval_ms
export GAMEPAD_BUTTON_CODES=$gamepad_button_codes
export GAMEPAD_DEBUG=$gamepad_debug
if [ -n "$gamepad_event_record_size" ]; then
  export GAMEPAD_EVENT_RECORD_SIZE=$gamepad_event_record_size
fi
echo "ALSA_OUTPUT_DEVICE=$ALSA_OUTPUT_DEVICE"
echo "ALSA_INPUT_DEVICE=$ALSA_INPUT_DEVICE"
echo "ALSA_VOLUME_CONTROL=$alsa_volume_control"
echo "WAVESHARE_BUTTON_GPIOCHIP=$WAVESHARE_BUTTON_GPIOCHIP"
echo "WAVESHARE_BUTTON_LINE=$WAVESHARE_BUTTON_LINE"
echo "WAVESHARE_BUTTON_GPIO=$WAVESHARE_BUTTON_GPIO"
echo "BUTTON_GPIO_ACTIVE_LOW=$BUTTON_GPIO_ACTIVE_LOW"
echo "BUTTON_GPIO_POLL_INTERVAL_MS=$BUTTON_GPIO_POLL_INTERVAL_MS"
echo "GAMEPAD_LISTENER_ENABLED=$gamepad_listener_enabled"
echo "GAMEPAD_SCAN_INTERVAL_MS=$gamepad_scan_interval_ms"
echo "GAMEPAD_BUTTON_CODES=$gamepad_button_codes"
echo "GAMEPAD_DEBUG=$gamepad_debug"
if [ -n "$gamepad_event_record_size" ]; then
  echo "GAMEPAD_EVENT_RECORD_SIZE=$gamepad_event_record_size"
fi

log_gamepad_preflight() {
  echo "===== Gamepad preflight ====="
  if [ "$gamepad_listener_enabled" != "true" ]; then
    echo "Gamepad listener is disabled by env."
    echo "============================="
    return
  fi

  if [ ! -d "/dev/input" ]; then
    echo "/dev/input does not exist."
    echo "============================="
    return
  fi

  event_nodes=$(ls /dev/input/event* 2>/dev/null || true)
  if [ -z "$event_nodes" ]; then
    echo "No /dev/input/event* devices found."
    echo "============================="
    return
  fi

  for event_node in $event_nodes; do
    event_name=$(basename "$event_node")
    name_file="/sys/class/input/$event_name/device/name"
    device_name="unknown"
    if [ -f "$name_file" ]; then
      device_name=$(cat "$name_file")
    fi
    perms=$(ls -l "$event_node")
    echo "$event_node | name=$device_name"
    echo "  $perms"
  done

  if command -v id >/dev/null 2>&1; then
    echo "Current groups: $(id -nG)"
  fi
  echo "Expected gamepad button codes: $gamepad_button_codes"
  echo "============================="
}

# Adjust initial volume (with retries on boot to wait for card/control readiness)
set_initial_volume() {
  local attempts=20
  local delay_sec=1
  local i=1
  while [ $i -le $attempts ]; do
    if amixer -c "$card_index" set "$alsa_volume_control" "$initial_volume_level" >/dev/null 2>&1; then
      echo "Initial volume applied: control=$alsa_volume_control value=$initial_volume_level (card $card_index)"
      amixer -c "$card_index" get "$alsa_volume_control" | tail -n 5
      return 0
    fi
    echo "Waiting for ALSA control '$alsa_volume_control' on card $card_index (attempt $i/$attempts)..."
    sleep "$delay_sec"
    i=$((i + 1))
  done
  echo "Warning: failed to apply initial volume to '$alsa_volume_control' on card $card_index."
  return 1
}

set_initial_volume || true
log_gamepad_preflight

if [ "$serve_ollama" = true ]; then
  echo "Starting Ollama server..."
  export OLLAMA_KEEP_ALIVE=-1 # ensure Ollama server stays alive
  OLLAMA_HOST=0.0.0.0:11434 ollama serve &
fi

# if file use_npm exists and is true, use npm
if [ -f "use_npm" ]; then
  use_npm=true
else
  use_npm=false
fi

if [ "$use_npm" = true ]; then
  echo "Using npm to start the application..."
  SOUND_CARD_INDEX=$card_index npm start
else
  echo "Using yarn to start the application..."
  SOUND_CARD_INDEX=$card_index yarn start
fi

# After the service ends, perform cleanup
echo "Cleaning up after service..."

if [ "$serve_ollama" = true ]; then
  echo "Stopping Ollama server..."
  pkill ollama
fi

# Record end status
echo "===== Service ended: $(date) ====="
