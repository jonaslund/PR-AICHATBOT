import * as fs from "fs";
import * as path from "path";
import { getAudioDurationInSeconds } from "get-audio-duration";
import dotenv from "dotenv";
import { ttsDir } from "../../utils/dir";
import { TTSResult } from "../../type";
import * as ort from "onnxruntime-node";

dotenv.config();

const ttsServer = (process.env.TTS_SERVER || "").toLowerCase();
// Supertonic configuration from environment variables
const supertonicAssetsDir =
  process.env.SUPERTONIC_ASSETS_DIR &&
  path.isAbsolute(process.env.SUPERTONIC_ASSETS_DIR)
    ? process.env.SUPERTONIC_ASSETS_DIR
    : path.resolve(
        process.cwd(),
        process.env.SUPERTONIC_ASSETS_DIR || "assets",
      );
const supertonicOnnxDir = path.join(supertonicAssetsDir, "onnx");
const supertonicVoiceStyle = process.env.SUPERTONIC_VOICE_STYLE || "M1"; // M1-M5, F1-F5
const supertonicLanguage = process.env.SUPERTONIC_LANGUAGE || "en"; // en, ko, es, pt, fr
const supertonicTotalStep = parseInt(process.env.SUPERTONIC_TOTAL_STEP || "5"); // Higher = better quality
const supertonicSpeed = parseFloat(process.env.SUPERTONIC_SPEED || "1.05"); // Speed multiplier
const supertonicSilenceDuration = parseFloat(
  process.env.SUPERTONIC_SILENCE_DURATION || "0.3",
); // Silence between chunks

interface Config {
  ae: {
    sample_rate: number;
    base_chunk_size: number;
    chunk_compress: number;
    latent_dim: number;
  };
  dp: {
    text_emb_dim: number;
    text_dim: number;
  };
}

interface Style {
  ttl: ort.Tensor;
  dp: ort.Tensor;
}

interface UnicodeProcessor {
  encode: (text: string, lang: string) => { tokens: number[]; length: number };
}

class SupertonicTTS {
  private config: Config | null = null;
  private textProcessor: UnicodeProcessor | null = null;
  private dpSession: ort.InferenceSession | null = null;
  private textEncSession: ort.InferenceSession | null = null;
  private vectorEstSession: ort.InferenceSession | null = null;
  private vocoderSession: ort.InferenceSession | null = null;
  private style: Style | null = null;
  private sampleRate: number = 24000;
  private initialized: boolean = false;

  async initialize() {
    if (this.initialized) return;

    try {
      console.log("Initializing Supertonic TTS...");

      // Load configuration
      const configPath = path.join(supertonicOnnxDir, "config.json");
      if (!fs.existsSync(configPath)) {
        throw new Error(
          `Config file not found at ${configPath}. Please download Supertonic models first.`,
        );
      }
      this.config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      this.sampleRate = this.config!.ae.sample_rate;

      // Load text processor
      await this.loadTextProcessor();

      // Load ONNX models
      console.log("Loading ONNX models...");
      this.dpSession = await ort.InferenceSession.create(
        path.join(supertonicOnnxDir, "dp.onnx"),
      );
      this.textEncSession = await ort.InferenceSession.create(
        path.join(supertonicOnnxDir, "text_enc.onnx"),
      );
      this.vectorEstSession = await ort.InferenceSession.create(
        path.join(supertonicOnnxDir, "vector_est.onnx"),
      );
      this.vocoderSession = await ort.InferenceSession.create(
        path.join(supertonicOnnxDir, "vocoder.onnx"),
      );

      // Load voice style
      await this.loadVoiceStyle(supertonicVoiceStyle);

      this.initialized = true;
      console.log(
        `Supertonic TTS initialized successfully with voice ${supertonicVoiceStyle}`,
      );
    } catch (error) {
      console.error("Failed to initialize Supertonic TTS:", error);
      throw error;
    }
  }

  private async loadTextProcessor() {
    // Load unicode_lookup.json for text processing
    const unicodeLookupPath = path.join(
      supertonicOnnxDir,
      "unicode_lookup.json",
    );
    if (!fs.existsSync(unicodeLookupPath)) {
      throw new Error(`Unicode lookup file not found at ${unicodeLookupPath}`);
    }

    const unicodeLookup = JSON.parse(
      fs.readFileSync(unicodeLookupPath, "utf-8"),
    );

    this.textProcessor = {
      encode: (text: string, lang: string) => {
        const tokens: number[] = [];
        for (const char of text) {
          const key = `${char}:${lang}`;
          if (unicodeLookup[key] !== undefined) {
            tokens.push(unicodeLookup[key]);
          } else if (unicodeLookup[char] !== undefined) {
            tokens.push(unicodeLookup[char]);
          } else {
            // Unknown character, use space token
            tokens.push(unicodeLookup[" "] || 0);
          }
        }
        return { tokens, length: tokens.length };
      },
    };
  }

  private async loadVoiceStyle(voiceStyleName: string) {
    const voiceStylePath = path.join(
      supertonicAssetsDir,
      "voice_styles",
      `${voiceStyleName}.json`,
    );
    if (!fs.existsSync(voiceStylePath)) {
      throw new Error(`Voice style file not found at ${voiceStylePath}`);
    }

    const styleData = JSON.parse(fs.readFileSync(voiceStylePath, "utf-8"));

    // Convert style data to tensors
    this.style = {
      ttl: new ort.Tensor(
        "float32",
        Float32Array.from(styleData.ttl.flat(2)),
        styleData.ttl_shape,
      ),
      dp: new ort.Tensor(
        "float32",
        Float32Array.from(styleData.dp.flat(2)),
        styleData.dp_shape,
      ),
    };
  }

  private chunkText(text: string, maxLen: number = 300): string[] {
    if (text.length <= maxLen) {
      return [text];
    }

    const chunks: string[] = [];
    const paragraphs = text.split(/\n+/);

    for (const paragraph of paragraphs) {
      if (paragraph.length <= maxLen) {
        chunks.push(paragraph);
        continue;
      }

      // Split by sentences
      const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
      let currentChunk = "";

      for (const sentence of sentences) {
        if ((currentChunk + sentence).length <= maxLen) {
          currentChunk += sentence;
        } else {
          if (currentChunk) chunks.push(currentChunk.trim());
          currentChunk = sentence;
        }
      }
      if (currentChunk) chunks.push(currentChunk.trim());
    }

    return chunks.filter((c) => c.length > 0);
  }

  private async synthesizeChunk(
    text: string,
    lang: string,
  ): Promise<{ wav: Float32Array; duration: number }> {
    if (
      !this.initialized ||
      !this.textProcessor ||
      !this.config ||
      !this.style
    ) {
      throw new Error("Supertonic TTS not initialized");
    }

    // Encode text
    const encoded = this.textProcessor.encode(text, lang);
    const textTokens = new ort.Tensor(
      "int64",
      BigInt64Array.from(encoded.tokens.map((t) => BigInt(t))),
      [1, encoded.length],
    );
    const textLengths = new ort.Tensor(
      "int64",
      BigInt64Array.from([BigInt(encoded.length)]),
      [1],
    );

    // Text encoding
    const textEncFeeds = {
      text: textTokens,
      text_lengths: textLengths,
      ttl: this.style.ttl,
    };
    const textEncResults = await this.textEncSession!.run(textEncFeeds);
    const textEmb = textEncResults.text_emb;

    // Duration prediction
    const dpFeeds = {
      text_emb: textEmb,
      text_lengths: textLengths,
      dp_style: this.style.dp,
    };
    const dpResults = await this.dpSession!.run(dpFeeds);
    const duration = dpResults.duration_norm;
    const durationData = duration.data as Float32Array;
    const totalDuration = Array.from(durationData).reduce((a, b) => a + b, 0);

    // Sample noisy latent
    const latentLen = Math.ceil(
      (totalDuration * this.config.ae.sample_rate) /
        this.config.ae.base_chunk_size /
        this.config.ae.chunk_compress,
    );
    const latentSize = latentLen * this.config.ae.latent_dim;
    const noisyLatent = Float32Array.from(
      { length: latentSize },
      () => Math.random() * 2 - 1,
    );
    const xt = new ort.Tensor("float32", noisyLatent, [
      1,
      latentLen,
      this.config.ae.latent_dim,
    ]);

    // Vector estimation (denoising)
    for (let step = 0; step < supertonicTotalStep; step++) {
      const t = new ort.Tensor(
        "float32",
        Float32Array.from([step / supertonicTotalStep]),
        [1],
      );
      const vectorEstFeeds = {
        xt: xt,
        text_emb: textEmb,
        duration: duration,
        t: t,
        ttl: this.style.ttl,
      };
      const vectorEstResults = await this.vectorEstSession!.run(vectorEstFeeds);
      const v = vectorEstResults.v as ort.Tensor;

      // Update xt: xt = xt - v * dt
      const dt = 1 / supertonicTotalStep;
      const xtData = xt.data as Float32Array;
      const vData = v.data as Float32Array;
      for (let i = 0; i < xtData.length; i++) {
        xtData[i] = xtData[i] - vData[i] * dt;
      }
    }

    // Vocoder
    const vocoderFeeds = { latent: xt };
    const vocoderResults = await this.vocoderSession!.run(vocoderFeeds);
    const wav = vocoderResults.wav_tts as ort.Tensor;

    return {
      wav: wav.data as Float32Array,
      duration: totalDuration / supertonicSpeed,
    };
  }

  async synthesize(
    text: string,
  ): Promise<{ audioPath: string; duration: number }> {
    await this.initialize();

    // Chunk text for better handling of long texts
    const maxLen = supertonicLanguage === "ko" ? 120 : 300;
    const chunks = this.chunkText(text, maxLen);

    let concatenatedWav: Float32Array = new Float32Array(0);
    let totalDuration = 0;

    console.log(`Synthesizing ${chunks.length} chunk(s)...`);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(
        `Processing chunk ${i + 1}/${chunks.length}: "${chunk.substring(0, 50)}..."`,
      );

      const result = await this.synthesizeChunk(chunk, supertonicLanguage);

      // Add silence between chunks
      if (i > 0 && supertonicSilenceDuration > 0) {
        const silenceSamples = Math.floor(
          supertonicSilenceDuration * this.sampleRate,
        );
        const silence = new Float32Array(silenceSamples);
        concatenatedWav = new Float32Array([
          ...concatenatedWav,
          ...silence,
          ...result.wav,
        ]);
        totalDuration += supertonicSilenceDuration;
      } else {
        concatenatedWav = new Float32Array([...concatenatedWav, ...result.wav]);
      }

      totalDuration += result.duration;
    }

    // Save to WAV file
    const now = Date.now();
    const outputPath = path.join(ttsDir, `supertonic_${now}.wav`);
    this.writeWavFile(outputPath, concatenatedWav, this.sampleRate);

    // Get actual duration from file
    const actualDuration = await getAudioDurationInSeconds(outputPath);

    console.log(
      `Supertonic TTS completed: ${outputPath} (${actualDuration.toFixed(2)}s)`,
    );

    return { audioPath: outputPath, duration: actualDuration };
  }

  private writeWavFile(
    filePath: string,
    audioData: Float32Array,
    sampleRate: number,
  ) {
    // Convert float32 to int16
    const int16Data = new Int16Array(audioData.length);
    for (let i = 0; i < audioData.length; i++) {
      const s = Math.max(-1, Math.min(1, audioData[i]));
      int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    // Create WAV header
    const buffer = Buffer.alloc(44 + int16Data.length * 2);

    // RIFF header
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + int16Data.length * 2, 4);
    buffer.write("WAVE", 8);

    // fmt chunk
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16); // fmt chunk size
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(1, 22); // mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
    buffer.writeUInt16LE(2, 32); // block align
    buffer.writeUInt16LE(16, 34); // bits per sample

    // data chunk
    buffer.write("data", 36);
    buffer.writeUInt32LE(int16Data.length * 2, 40);

    // Write audio data
    for (let i = 0; i < int16Data.length; i++) {
      buffer.writeInt16LE(int16Data[i], 44 + i * 2);
    }

    fs.writeFileSync(filePath, buffer);
  }
}

// Singleton instance
let supertonicInstance: SupertonicTTS | null = null;

if (ttsServer === "supertonic") {
  supertonicInstance = new SupertonicTTS();
}

const supertonicTTS = async (text: string): Promise<TTSResult> => {
  try {
    if (!supertonicInstance) {
      supertonicInstance = new SupertonicTTS();
    }
    const result = await supertonicInstance.synthesize(text);
    return { filePath: result.audioPath, duration: result.duration };
  } catch (error) {
    console.error("Supertonic TTS error:", error);
    return { duration: 0 };
  }
};

export default supertonicTTS;
