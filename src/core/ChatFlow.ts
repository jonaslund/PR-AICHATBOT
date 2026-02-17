import moment from "moment";
import {
  getCurrentTimeTag,
  getRecordFileDurationMs,
  splitSentences,
} from "./../utils/index";
import { compact, get, noop } from "lodash";
import {
  onButtonPressed,
  onButtonReleased,
  onButtonDoubleClick,
  display,
  getCurrentStatus,
  onCameraCapture,
} from "../device/display";
import {
  recordAudio,
  recordAudioManually,
  recordFileFormat,
} from "../device/audio";
import {
  recognizeAudio,
  chatWithLLMStream,
  ttsProcessor,
} from "../cloud-api/server";
import { isImMode } from "../cloud-api/llm";
import { extractEmojis } from "../utils";
import { StreamResponser } from "./StreamResponsor";
import { cameraDir, recordingsDir } from "../utils/dir";
import { getLatestDisplayImg, setLatestCapturedImg } from "../utils/image";
import dotEnv from "dotenv";
import { getSystemPromptWithKnowledge } from "./Knowledge";
import { enableRAG } from "../cloud-api/knowledge";
import { WakeWordListener } from "../device/wakeword";
import { LLMServer } from "../type";
import { WhisplayIMBridgeServer } from "../device/im-bridge";
import { sendWhisplayIMMessage } from "../cloud-api/openclaw/openclaw-llm";

dotEnv.config();

class ChatFlow {
  currentFlowName: string = "";
  recordingsDir: string = "";
  currentRecordFilePath: string = "";
  asrText: string = "";
  streamResponser: StreamResponser;
  partialThinking: string = "";
  thinkingSentences: string[] = [];
  answerId: number = 0;
  enableCamera: boolean = false;
  knowledgePrompts: string[] = [];
  wakeWordListener: WakeWordListener | null = null;
  wakeSessionActive: boolean = false;
  wakeSessionStartAt: number = 0;
  wakeSessionLastSpeechAt: number = 0;
  wakeSessionIdleTimeoutMs: number =
    parseInt(process.env.WAKE_WORD_IDLE_TIMEOUT_SEC || "60") * 1000;
  wakeRecordMaxSec: number = parseInt(
    process.env.WAKE_WORD_RECORD_MAX_SEC || "60",
  );
  wakeEndKeywords: string[] = (process.env.WAKE_WORD_END_KEYWORDS || "byebye")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  endAfterAnswer: boolean = false;
  whisplayIMBridge: WhisplayIMBridgeServer | null = null;
  pendingExternalReply: string = "";

  constructor(options: { enableCamera?: boolean } = {}) {
    console.log(`[${getCurrentTimeTag()}] ChatBot started.`);
    this.recordingsDir = recordingsDir;
    this.setCurrentFlow("sleep");
    this.streamResponser = new StreamResponser(
      ttsProcessor,
      (sentences: string[]) => {
        if (!this.isAnswerFlow()) return;
        const fullText = sentences.join(" ");
        display({
          status: "answering",
          emoji: extractEmojis(fullText) || "😊",
          text: fullText,
          RGB: "#0000ff",
          scroll_speed: 3,
        });
      },
      (text: string) => {
        if (!this.isAnswerFlow()) return;
        display({
          status: "answering",
          text: text || undefined,
          scroll_speed: 3,
        });
      },
    );
    if (options?.enableCamera) {
      this.enableCamera = true;
    }

    const wakeEnabled = (process.env.WAKE_WORD_ENABLED || "").toLowerCase();
    if (wakeEnabled === "true") {
      this.wakeWordListener = new WakeWordListener();
      this.wakeWordListener.on("wake", () => {
        if (this.currentFlowName === "sleep") {
          this.startWakeSession();
        }
      });
      this.wakeWordListener.start();
    }

    if (isImMode) {
      this.whisplayIMBridge = new WhisplayIMBridgeServer();
      this.whisplayIMBridge.on("reply", (reply: string) => {
        this.pendingExternalReply = reply;
        this.setCurrentFlow("external_answer");
      });
      this.whisplayIMBridge.start();
    }
  }

  async recognizeAudio(path: string): Promise<string> {
    if ((await getRecordFileDurationMs(path)) < 500) {
      console.log("Record audio too short, skipping recognition.");
      return Promise.resolve("");
    }
    console.time(`[ASR time]`);
    const result = await recognizeAudio(path);
    console.timeEnd(`[ASR time]`);
    return result;
  }

  partialThinkingCallback = (partialThinking: string): void => {
    this.partialThinking += partialThinking;
    const { sentences, remaining } = splitSentences(this.partialThinking);
    if (sentences.length > 0) {
      this.thinkingSentences.push(...sentences);
      const displayText = this.thinkingSentences.join(" ");
      display({
        status: "Thinking",
        emoji: "🤔",
        text: displayText,
        RGB: "#ff6800", // yellow
        scroll_speed: 6,
      });
    }
    this.partialThinking = remaining;
  };

  setCurrentFlow = (flowName: string): void => {
    console.log(`[${getCurrentTimeTag()}] switch to:`, flowName);
    switch (flowName) {
      case "sleep":
        this.currentFlowName = "sleep";
        this.endAfterAnswer = false;
        onButtonPressed(() => {
          this.setCurrentFlow("listening");
        });
        onButtonReleased(noop);
        // camera mode
        if (this.enableCamera) {
          const captureImgPath = `${cameraDir}/capture-${moment().format(
            "YYYYMMDD-HHmmss",
          )}.jpg`;
          onButtonDoubleClick(() => {
            display({
              camera_mode: true,
              capture_image_path: captureImgPath,
            });
          });
          onCameraCapture(() => {
            setLatestCapturedImg(captureImgPath);
          });
        }
        display({
          status: "idle",
          emoji: "😴",
          RGB: "#000055",
          ...(getCurrentStatus().text === "Listening..."
            ? {
                text: `Long Press the button to say something${
                  this.enableCamera ? ",\ndouble click to launch camera" : ""
                }.`,
              }
            : {}),
        });
        break;
      case "listening":
        this.answerId += 1;
        this.currentFlowName = "listening";
        this.wakeSessionActive = false;
        this.endAfterAnswer = false;
        this.currentRecordFilePath = `${
          this.recordingsDir
        }/user-${Date.now()}.${recordFileFormat}`;
        onButtonPressed(noop);
        const { result, stop } = recordAudioManually(
          this.currentRecordFilePath,
        );
        onButtonReleased(() => {
          stop();
          display({
            RGB: "#ff6800", // yellow
          });
        });
        result
          .then(() => {
            this.setCurrentFlow("asr");
          })
          .catch((err) => {
            console.error("Error during recording:", err);
            this.setCurrentFlow("sleep");
          });
        display({
          status: "listening",
          emoji: "😐",
          RGB: "#00ff00",
          text: "Listening...",
        });
        break;
      case "wake_listening":
        this.answerId += 1;
        this.currentFlowName = "wake_listening";
        this.currentRecordFilePath = `${
          this.recordingsDir
        }/user-${Date.now()}.${recordFileFormat}`;
        onButtonPressed(() => {
          this.setCurrentFlow("listening");
        });
        onButtonReleased(noop);
        recordAudio(this.currentRecordFilePath, this.wakeRecordMaxSec)
          .then(() => {
            this.setCurrentFlow("asr");
          })
          .catch((err) => {
            console.error("Error during auto recording:", err);
            this.endWakeSession();
            this.setCurrentFlow("sleep");
          });
        display({
          status: "listening",
          emoji: "😐",
          RGB: "#00ff00",
          text: "Listening...",
        });
        break;
      case "asr":
        this.currentFlowName = "asr";
        display({
          status: "recognizing",
        });
        onButtonDoubleClick(null);
        Promise.race([
          this.recognizeAudio(this.currentRecordFilePath),
          new Promise<string>((resolve) => {
            onButtonPressed(() => {
              resolve("[UserPress]");
            });
            onButtonReleased(noop);
          }),
        ]).then((result) => {
          if (this.currentFlowName !== "asr") return;
          if (result === "[UserPress]") {
            this.setCurrentFlow("listening");
          } else {
            if (result) {
              console.log("Audio recognized result:", result);
              this.asrText = result;
              if (this.wakeSessionActive) {
                this.wakeSessionLastSpeechAt = Date.now();
                this.endAfterAnswer = this.shouldEndAfterAnswer(result);
              }
              display({ status: "recognizing", text: result });
              this.setCurrentFlow("answer");
            } else {
              if (this.wakeSessionActive) {
                if (this.shouldContinueWakeSession()) {
                  this.setCurrentFlow("wake_listening");
                } else {
                  this.endWakeSession();
                  this.setCurrentFlow("sleep");
                }
              } else {
                this.setCurrentFlow("sleep");
              }
            }
          }
        });
        break;
      case "answer":
        display({
          status: "answering...",
          RGB: "#00c8a3",
        });
        this.currentFlowName = "answer";
        const currentAnswerId = this.answerId;
        if (isImMode) {
          const prompt: {
            role: "system" | "user";
            content: string;
          }[] = [
            {
              role: "user",
              content: this.asrText,
            },
          ];
          sendWhisplayIMMessage(prompt)
            .then((ok) => {
              if (ok) {
                display({
                  status: "idle",
                  emoji: "🦞",
                  RGB: "#000055",
                });
              } else {
                display({
                  status: "error",
                  emoji: "⚠️",
                  text: "OpenClaw send failed",
                });
              }
            })
            .finally(() => {
              this.setCurrentFlow("sleep");
            });
          break;
        }
        onButtonPressed(() => {
          this.setCurrentFlow("listening");
        });
        onButtonReleased(noop);
        const {
          partial,
          endPartial,
          getPlayEndPromise,
          stop: stopPlaying,
        } = this.streamResponser;
        this.partialThinking = "";
        this.thinkingSentences = [];
        [() => Promise.resolve().then(() => ""), getSystemPromptWithKnowledge]
          [enableRAG ? 1 : 0](this.asrText)
          .then((res: string) => {
            let knowledgePrompt = res;
            if (res) {
              console.log("Retrieved knowledge for RAG:\n", res);
            }
            if (this.knowledgePrompts.includes(res)) {
              console.log(
                "[RAG] Knowledge prompt already used in this session, skipping to avoid repetition.",
              );
              knowledgePrompt = "";
            }
            if (knowledgePrompt) {
              this.knowledgePrompts.push(knowledgePrompt);
            }
            const prompt: {
              role: "system" | "user";
              content: string;
            }[] = compact([
              knowledgePrompt
                ? {
                    role: "system",
                    content: knowledgePrompt,
                  }
                : null,
              {
                role: "user",
                content: this.asrText,
              },
            ]);
            chatWithLLMStream(
              prompt,
              (text) => currentAnswerId === this.answerId && partial(text),
              () => currentAnswerId === this.answerId && endPartial(),
              (partialThinking) =>
                currentAnswerId === this.answerId &&
                this.partialThinkingCallback(partialThinking),
              (functionName: string, result?: string) => {
                if (result) {
                  display({
                    text: `[${functionName}]${result}`,
                  });
                } else {
                  display({
                    text: `Invoking [${functionName}]...`,
                  });
                }
              },
            );
          });
        getPlayEndPromise().then(() => {
          if (this.currentFlowName === "answer") {
            if (this.wakeSessionActive) {
              if (this.endAfterAnswer) {
                this.endWakeSession();
                this.setCurrentFlow("sleep");
              } else {
                this.setCurrentFlow("wake_listening");
              }
              return;
            }
            const img = getLatestDisplayImg();
            if (img) {
              display({
                image: img,
              });
              this.setCurrentFlow("image");
            } else {
              this.setCurrentFlow("sleep");
            }
          }
        });
        onButtonPressed(() => {
          stopPlaying();
          this.setCurrentFlow("listening");
        });
        onButtonReleased(noop);
        break;
      case "image":
        onButtonPressed(() => {
          display({ image: "" });
          this.setCurrentFlow("listening");
        });
        onButtonReleased(noop);
        break;
      case "external_answer":
        this.currentFlowName = "external_answer";
        if (!this.pendingExternalReply) {
          this.setCurrentFlow("sleep");
          break;
        }
        display({
          status: "answering...",
          RGB: "#00c8a3",
        });
        onButtonPressed(() => {
          this.streamResponser.stop();
          this.setCurrentFlow("listening");
        });
        onButtonReleased(noop);
        const replyText = this.pendingExternalReply;
        this.pendingExternalReply = "";
        this.streamExternalReply(replyText);
        this.streamResponser.getPlayEndPromise().then(() => {
          if (this.currentFlowName !== "external_answer") return;
          if (this.wakeSessionActive) {
            if (this.endAfterAnswer) {
              this.endWakeSession();
              this.setCurrentFlow("sleep");
            } else {
              this.setCurrentFlow("wake_listening");
            }
          } else {
            this.setCurrentFlow("sleep");
          }
        });
        break;
      default:
        console.error("Unknown flow name:", flowName);
        break;
    }
  };

  isAnswerFlow = (): boolean => {
    return this.currentFlowName === "answer" || this.currentFlowName === "external_answer";
  };

  streamExternalReply = async (text: string): Promise<void> => {
    if (!text) {
      this.streamResponser.endPartial();
      return;
    }
    const { sentences, remaining } = splitSentences(text);
    const parts = [...sentences];
    if (remaining.trim()) {
      parts.push(remaining);
    }
    for (const part of parts) {
      this.streamResponser.partial(part);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    this.streamResponser.endPartial();
  };

  startWakeSession = (): void => {
    this.wakeSessionActive = true;
    this.wakeSessionStartAt = Date.now();
    this.wakeSessionLastSpeechAt = this.wakeSessionStartAt;
    this.endAfterAnswer = false;
    this.setCurrentFlow("wake_listening");
  };

  endWakeSession = (): void => {
    this.wakeSessionActive = false;
    this.endAfterAnswer = false;
  };

  shouldContinueWakeSession = (): boolean => {
    if (!this.wakeSessionActive) return false;
    const last = this.wakeSessionLastSpeechAt || this.wakeSessionStartAt;
    return Date.now() - last < this.wakeSessionIdleTimeoutMs;
  };

  shouldEndAfterAnswer = (text: string): boolean => {
    const lower = text.toLowerCase();
    return this.wakeEndKeywords.some(
      (keyword) => keyword && lower.includes(keyword),
    );
  };
}

export default ChatFlow;
