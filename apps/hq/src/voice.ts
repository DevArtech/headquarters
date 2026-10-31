import { KokoroTTS } from "kokoro-js";

/**
 * G.A.R.T.H.'s voice: Kokoro-82M, an open-weight neural TTS model, running locally on the HQ machine
 * (no API key, nothing leaves the machine). Loaded once in the background at boot; requests are
 * synthesised one at a time in arrival order, which keeps sentences in order for the browser.
 *
 * GARTH_TTS=browser disables it (the UI falls back to the browser's built-in voice).
 */
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
// On Apple Silicon CPU, fp32 is faster than the quantised variants (measured: 1.9x vs 1.2x realtime).
const DTYPE = (process.env.GARTH_VOICE_DTYPE ?? "fp32") as "fp32" | "fp16" | "q8" | "q4" | "q4f16";

export const voiceConfig = {
  enabled: process.env.GARTH_TTS !== "browser",
  voice: process.env.GARTH_VOICE ?? "am_michael",
  speed: Number(process.env.GARTH_VOICE_SPEED ?? 1.05),
};

let model: Promise<KokoroTTS> | null = null;
let state: "off" | "loading" | "ready" | "error" = voiceConfig.enabled ? "off" : "off";
let lastError = "";
let queue: Promise<unknown> = Promise.resolve();

export function loadVoice(): Promise<KokoroTTS> {
  if (!voiceConfig.enabled) return Promise.reject(new Error("neural voice disabled (GARTH_TTS=browser)"));
  if (!model) {
    state = "loading";
    const t = Date.now();
    model = KokoroTTS.from_pretrained(MODEL, { dtype: DTYPE, device: "cpu" }).then(
      (m) => {
        state = "ready";
        console.log(`[voice] Kokoro ready in ${Date.now() - t}ms (voice ${voiceConfig.voice})`);
        return m;
      },
      (e) => {
        state = "error";
        lastError = (e as Error).message;
        model = null;
        console.error("[voice] could not load Kokoro:", lastError);
        throw e;
      },
    );
  }
  return model;
}

export function voiceStatus() {
  return { engine: voiceConfig.enabled ? "kokoro" : "browser", state, voice: voiceConfig.voice, error: lastError || undefined };
}

/** Synthesise one sentence to a WAV file. */
export async function synthesize(text: string, voice = voiceConfig.voice): Promise<ArrayBuffer> {
  const tts = await loadVoice();
  const job = queue.then(() => tts.generate(text, { voice: voice as never, speed: voiceConfig.speed }));
  queue = job.catch(() => {});
  return (await job).toWav();
}

/** Voices the model offers, best first, so G.A.R.T.H. can describe the options. */
export async function listVoices() {
  const tts = await loadVoice();
  const order = ["A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F+", "F"];
  return Object.entries(tts.voices as Record<string, { name: string; language: string; gender: string; overallGrade: string }>)
    .map(([id, v]) => ({ id, name: v.name, accent: v.language === "en-gb" ? "British" : "American", gender: v.gender, grade: v.overallGrade }))
    .sort((a, b) => order.indexOf(a.grade) - order.indexOf(b.grade));
}

/** Change the voice and/or speed live; the next sentence spoken uses it. */
export async function setVoice(change: { voice?: string; speed?: number }) {
  if (change.voice) {
    const tts = await loadVoice();
    if (!(change.voice in tts.voices)) throw new Error(`unknown voice "${change.voice}"; call list_voices for the options`);
    voiceConfig.voice = change.voice;
  }
  if (change.speed !== undefined) {
    if (!(change.speed >= 0.5 && change.speed <= 2)) throw new Error("speed must be between 0.5 and 2");
    voiceConfig.speed = change.speed;
  }
  return { voice: voiceConfig.voice, speed: voiceConfig.speed };
}
