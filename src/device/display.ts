import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

interface Status {
  status: string;
  emoji: string;
  text: string;
  scroll_speed: number;
  brightness: number;
  RGB: string;
  battery_color: string;
  battery_level: number | undefined;
  image: string;
  camera_mode: boolean;
  capture_image_path: string;
  network_connected: boolean;
  rag_icon_visible: boolean;
}

type ButtonCallback = () => void;

const parseBoolean = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
};

const parseNumberList = (value: string | undefined, fallback: number[]): number[] => {
  if (!value) return fallback;
  const parsed = value
    .split(",")
    .map((item) => parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item));
  return parsed.length > 0 ? parsed : fallback;
};

class HardwareDisplay {
  private currentStatus: Status = {
    status: "starting",
    emoji: "😊",
    text: "",
    scroll_speed: 3,
    brightness: 100,
    RGB: "#00FF30",
    battery_color: "#000000",
    battery_level: undefined,
    image: "",
    camera_mode: false,
    capture_image_path: "",
    network_connected: false,
    rag_icon_visible: false,
  };

  private buttonPressedCallback: ButtonCallback = () => {};
  private buttonReleasedCallback: ButtonCallback = () => {};
  private buttonDoubleClickCallback: ButtonCallback | null = null;
  private onCameraCaptureCallback: ButtonCallback = () => {};

  private buttonPressTimeArray: number[] = [];
  private buttonReleaseTimeArray: number[] = [];
  private buttonDetectInterval: NodeJS.Timeout | null = null;

  private readonly sourcesPressed = new Set<string>();

  private gpioPollTimer: NodeJS.Timeout | null = null;
  private gpioValuePath: string | null = null;
  private lastGpioValue: string | null = null;
  private gpioUseGpiogetFallback: boolean = false;

  private gamepadScanTimer: NodeJS.Timeout | null = null;
  private readonly gamepadStreams = new Map<string, fs.ReadStream>();
  private readonly gamepadBufferMap = new Map<string, Buffer>();
  private readonly gamepadRecordSize = process.arch.includes("64") ? 24 : 16;

  private readonly gpioPin = parseInt(process.env.WAVESHARE_BUTTON_GPIO || process.env.BUTTON_GPIO || "17", 10);
  private readonly gpioChip = process.env.WAVESHARE_BUTTON_GPIOCHIP || "gpiochip0";
  private readonly gpioLine = parseInt(
    process.env.WAVESHARE_BUTTON_LINE || process.env.WAVESHARE_BUTTON_GPIO || process.env.BUTTON_GPIO || "17",
    10,
  );
  private readonly gpioPollIntervalMs = parseInt(process.env.BUTTON_GPIO_POLL_INTERVAL_MS || "20", 10);
  private readonly gpioActiveLow = parseBoolean(process.env.BUTTON_GPIO_ACTIVE_LOW, true);
  private readonly gamepadEnabled = parseBoolean(process.env.GAMEPAD_LISTENER_ENABLED, true);
  private readonly gamepadScanIntervalMs = parseInt(process.env.GAMEPAD_SCAN_INTERVAL_MS || "5000", 10);
  private readonly gamepadButtonCodes = new Set(
    parseNumberList(process.env.GAMEPAD_BUTTON_CODES, [304, 305, 307, 308]),
  );

  constructor() {
    this.startGPIOListener();
    this.startGamepadListener();
  }

  onButtonPressed(callback: ButtonCallback): void {
    this.buttonPressedCallback = callback;
  }

  onButtonReleased(callback: ButtonCallback): void {
    this.buttonReleasedCallback = callback;
  }

  onButtonDoubleClick(callback: ButtonCallback | null): void {
    this.buttonDoubleClickCallback = callback;
  }

  onCameraCapture(callback: ButtonCallback): void {
    this.onCameraCaptureCallback = callback;
  }

  getCurrentStatus(): Status {
    return this.currentStatus;
  }

  async display(newStatus: Partial<Status> = {}): Promise<void> {
    const prevStatus = this.currentStatus.status;
    const prevText = this.currentStatus.text;
    this.currentStatus = {
      ...this.currentStatus,
      ...newStatus,
      brightness: 100,
    };

    if (newStatus.camera_mode) {
      console.log("[Display] Camera mode requested but not supported without Whisplay display hardware.");
    }

    if (
      newStatus.status &&
      (newStatus.status !== prevStatus || (newStatus.text && newStatus.text !== prevText))
    ) {
      console.log(
        `[Display] ${this.currentStatus.status}${this.currentStatus.text ? `: ${this.currentStatus.text}` : ""}`,
      );
    }
  }

  cleanup(): void {
    if (this.gpioPollTimer) {
      clearInterval(this.gpioPollTimer);
      this.gpioPollTimer = null;
    }
    if (this.gamepadScanTimer) {
      clearInterval(this.gamepadScanTimer);
      this.gamepadScanTimer = null;
    }
    this.gamepadStreams.forEach((stream) => stream.destroy());
    this.gamepadStreams.clear();
    this.gamepadBufferMap.clear();
  }

  private startMonitoringDoubleClick(): void {
    if (this.buttonDetectInterval || !this.buttonDoubleClickCallback) return;

    this.buttonDetectInterval = setTimeout(() => {
      const now = Date.now();
      this.buttonPressTimeArray = this.buttonPressTimeArray.filter((time) => now - time <= 1000);
      this.buttonReleaseTimeArray = this.buttonReleaseTimeArray.filter((time) => now - time <= 1000);

      const doubleClickDetected =
        this.buttonPressTimeArray.length >= 2 && this.buttonReleaseTimeArray.length >= 2;

      if (doubleClickDetected) {
        this.buttonDoubleClickCallback?.();
      } else {
        const lastReleaseTime = this.buttonReleaseTimeArray.pop() || 0;
        const lastPressTime = this.buttonPressTimeArray.pop() || 0;
        if (!lastReleaseTime || lastReleaseTime < lastPressTime) {
          this.buttonPressedCallback();
        }
      }

      this.buttonPressTimeArray = [];
      this.buttonReleaseTimeArray = [];
      this.buttonDetectInterval = null;
    }, 800);
  }

  private handleButtonPressed(sourceId: string): void {
    const wasPressed = this.sourcesPressed.size > 0;
    this.sourcesPressed.add(sourceId);
    if (wasPressed) {
      return;
    }

    this.buttonPressTimeArray.push(Date.now());
    this.startMonitoringDoubleClick();
    if (!this.buttonDetectInterval) {
      this.buttonPressedCallback();
    }
  }

  private handleButtonReleased(sourceId: string): void {
    const existed = this.sourcesPressed.delete(sourceId);
    if (!existed || this.sourcesPressed.size > 0) {
      return;
    }

    this.buttonReleaseTimeArray.push(Date.now());
    if (!this.buttonDetectInterval) {
      this.buttonReleasedCallback();
    }
  }

  private startGPIOListener(): void {
    if (!Number.isFinite(this.gpioPin)) {
      console.warn("[GPIO] Invalid WAVESHARE_BUTTON_GPIO, GPIO button listener disabled.");
      return;
    }

    const gpioDir = `/sys/class/gpio/gpio${this.gpioPin}`;
    this.gpioValuePath = path.join(gpioDir, "value");

    try {
      if (!fs.existsSync(gpioDir)) {
        try {
          fs.writeFileSync("/sys/class/gpio/export", `${this.gpioPin}`);
        } catch (error: any) {
          if (error?.code !== "EBUSY") {
            throw new Error(`sysfs GPIO export failed (${error?.message || error})`);
          }
        }
      }

      const writeIfExists = (filePath: string, value: string): void => {
        if (!fs.existsSync(filePath)) return;
        try {
          fs.writeFileSync(filePath, value);
        } catch (error) {
          console.warn(`[GPIO] Skipping ${path.basename(filePath)} write (${value}):`, error);
        }
      };

      writeIfExists(path.join(gpioDir, "direction"), "in");
      writeIfExists(path.join(gpioDir, "active_low"), this.gpioActiveLow ? "1" : "0");
      writeIfExists(path.join(gpioDir, "edge"), "both");
    } catch (error) {
      console.warn("[GPIO] sysfs init failed, trying gpioget fallback:", error);
      if (!Number.isFinite(this.gpioLine)) {
        console.warn("[GPIO] Invalid WAVESHARE_BUTTON_LINE, GPIO listener disabled.");
        this.gpioValuePath = null;
        return;
      }
      this.gpioUseGpiogetFallback = true;
      this.gpioValuePath = null;
    }

    if (!this.gpioUseGpiogetFallback) {
      try {
        this.lastGpioValue = fs.readFileSync(this.gpioValuePath!, "utf8").trim();
      } catch {
        this.lastGpioValue = null;
      }
      console.log(`[GPIO] Listening on BCM ${this.gpioPin} (active_low=${this.gpioActiveLow}).`);
    } else {
      console.log(
        `[GPIO] Listening via gpioget on ${this.gpioChip} line ${this.gpioLine} (active_low=${this.gpioActiveLow}).`,
      );
    }

    this.gpioPollTimer = setInterval(() => {
      try {
        const raw = this.gpioUseGpiogetFallback
          ? execFileSync("gpioget", ["-c", this.gpioChip, `${this.gpioLine}`], { encoding: "utf8" }).trim()
          : fs.readFileSync(this.gpioValuePath!, "utf8").trim();
        if (this.lastGpioValue === null) {
          this.lastGpioValue = raw;
          return;
        }
        if (raw === this.lastGpioValue) {
          return;
        }
        this.lastGpioValue = raw;

        const isPressed = this.gpioActiveLow ? raw === "0" : raw === "1";
        if (isPressed) {
          this.handleButtonPressed(`gpio:${this.gpioPin}`);
        } else {
          this.handleButtonReleased(`gpio:${this.gpioPin}`);
        }
      } catch {
        // Keep polling even when temporary GPIO read errors occur.
      }
    }, this.gpioPollIntervalMs);
  }

  private startGamepadListener(): void {
    if (!this.gamepadEnabled) {
      console.log("[Gamepad] Listener disabled by GAMEPAD_LISTENER_ENABLED=false.");
      return;
    }

    this.scanGamepadDevices();
    this.gamepadScanTimer = setInterval(() => {
      this.scanGamepadDevices();
    }, this.gamepadScanIntervalMs);
  }

  private scanGamepadDevices(): void {
    const inputDir = "/dev/input";
    if (!fs.existsSync(inputDir)) {
      return;
    }

    const eventDevices = fs
      .readdirSync(inputDir)
      .filter((file) => file.startsWith("event"))
      .map((file) => path.join(inputDir, file));

    eventDevices.forEach((eventPath) => {
      if (this.gamepadStreams.has(eventPath)) {
        return;
      }

      const eventName = path.basename(eventPath);
      const deviceNamePath = `/sys/class/input/${eventName}/device/name`;
      const deviceName = fs.existsSync(deviceNamePath)
        ? fs.readFileSync(deviceNamePath, "utf8").trim().toLowerCase()
        : "";

      const looksLikeController =
        deviceName.includes("gamepad") ||
        deviceName.includes("joystick") ||
        deviceName.includes("arcade") ||
        deviceName.includes("controller");

      if (!looksLikeController) {
        return;
      }

      try {
        const stream = fs.createReadStream(eventPath);
        this.gamepadStreams.set(eventPath, stream);
        this.gamepadBufferMap.set(eventPath, Buffer.alloc(0));
        console.log(`[Gamepad] Listening on ${eventPath} (${deviceName || "unknown"}).`);

        stream.on("data", (chunk: string | Buffer) => {
          const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          this.consumeGamepadEvents(eventPath, chunkBuffer);
        });

        stream.on("error", (error) => {
          console.warn(`[Gamepad] Stream error on ${eventPath}:`, error);
          this.detachGamepad(eventPath);
        });

        stream.on("close", () => {
          this.detachGamepad(eventPath);
        });
      } catch (error) {
        console.warn(`[Gamepad] Failed to open ${eventPath}:`, error);
      }
    });
  }

  private consumeGamepadEvents(eventPath: string, chunk: Buffer): void {
    const previous = this.gamepadBufferMap.get(eventPath) || Buffer.alloc(0);
    let buffer = Buffer.concat([previous, chunk]);

    while (buffer.length >= this.gamepadRecordSize) {
      const eventBuffer = buffer.subarray(0, this.gamepadRecordSize);
      buffer = buffer.subarray(this.gamepadRecordSize);

      const eventOffset = this.gamepadRecordSize - 8;
      const type = eventBuffer.readUInt16LE(eventOffset);
      const code = eventBuffer.readUInt16LE(eventOffset + 2);
      const value = eventBuffer.readInt32LE(eventOffset + 4);

      if (type !== 1 || !this.gamepadButtonCodes.has(code)) {
        continue;
      }

      const sourceId = `gamepad:${eventPath}:${code}`;
      if (value === 1) {
        this.handleButtonPressed(sourceId);
      } else if (value === 0) {
        this.handleButtonReleased(sourceId);
      }
    }

    this.gamepadBufferMap.set(eventPath, buffer);
  }

  private detachGamepad(eventPath: string): void {
    const stream = this.gamepadStreams.get(eventPath);
    if (stream) {
      stream.destroy();
    }
    this.gamepadStreams.delete(eventPath);
    this.gamepadBufferMap.delete(eventPath);

    Array.from(this.sourcesPressed)
      .filter((sourceId) => sourceId.includes(eventPath))
      .forEach((sourceId) => this.handleButtonReleased(sourceId));
  }
}

const displayInstance = new HardwareDisplay();

export const display = displayInstance.display.bind(displayInstance);
export const getCurrentStatus = displayInstance.getCurrentStatus.bind(displayInstance);
export const onButtonPressed = displayInstance.onButtonPressed.bind(displayInstance);
export const onButtonReleased = displayInstance.onButtonReleased.bind(displayInstance);
export const onButtonDoubleClick = displayInstance.onButtonDoubleClick.bind(displayInstance);
export const onCameraCapture = displayInstance.onCameraCapture.bind(displayInstance);

function cleanup() {
  displayInstance.cleanup();
}

process.on("exit", cleanup);
["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, () => {
    cleanup();
    process.exit(0);
  });
});
process.on("uncaughtException", () => {
  cleanup();
  process.exit(1);
});
process.on("unhandledRejection", () => {
  cleanup();
  process.exit(1);
});
