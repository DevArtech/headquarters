/**
 * G.A.R.T.H.'s voice, fed by the token stream: text is spoken a sentence at a time as soon as each
 * sentence completes, so the voice starts while G.A.R.T.H. is still generating.
 *
 * Engine: Kokoro neural TTS on Headquarters (/api/tts) — each sentence is fetched as a WAV while the
 * previous one plays, and scheduled gaplessly with Web Audio. If HQ's voice is unavailable, the
 * browser's built-in speech synthesis is used instead.
 */
import { speakName } from "@hq/protocol";

type Listener = (speaking: boolean) => void;

const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
let enabled = true; // set from the voiceOn setting when the page loads; the mute button lasts until reload
let buffer = "";
let active = 0;
let engine: "hq" | "browser" = "browser";
let generation = 0; // bumped by stop(): late audio from an older generation is dropped
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(active > 0);
}
const started = () => (active++, emit());
const ended = () => ((active = Math.max(0, active - 1)), emit());

/** Strip what reads badly aloud: markdown, code, URLs. */
function speakable(s: string) {
  return speakName(s)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/[*_#>|~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── neural voice on HQ ─────────────────────────────────────────────────
let ctx: AudioContext | null = null;
let playhead = 0; // when the next clip should start (AudioContext time)
let chain: Promise<void> = Promise.resolve(); // keeps clips in sentence order
const sources = new Set<AudioBufferSourceNode>();
const inflight = new Set<AbortController>();

function audio() {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}
// browsers only allow audio after a user gesture: unlock on the first one
if (typeof window !== "undefined") {
  const unlock = () => {
    audio();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  fetch("/api/tts")
    .then((r) => r.json())
    .then((s: { engine: string; state: string }) => {
      if (s.engine === "kokoro" && s.state !== "error") engine = "hq";
    })
    .catch(() => {});
}

function speakHq(text: string) {
  const gen = generation;
  const ac = new AbortController();
  inflight.add(ac);
  // start fetching now (in parallel with what's playing); play in order
  const clip = fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: ac.signal })
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`tts ${r.status}`))))
    .then((buf) => audio().decodeAudioData(buf))
    .finally(() => inflight.delete(ac));
  chain = chain.then(async () => {
    let buf: AudioBuffer;
    try {
      buf = await clip;
    } catch (e) {
      if (gen === generation && (e as Error).name !== "AbortError") speakBrowser(text); // fall back for this sentence
      return;
    }
    if (gen !== generation || !enabled) return;
    const c = audio();
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    playhead = Math.max(playhead, c.currentTime + 0.02);
    src.start(playhead);
    playhead += buf.duration;
    sources.add(src);
    started();
    src.onended = () => {
      sources.delete(src);
      ended();
    };
  });
}

// ── browser fallback ───────────────────────────────────────────────────
let voice: SpeechSynthesisVoice | null = null;
const PREFERRED = ["Daniel", "Arthur", "Oliver", "Google UK English Male", "Microsoft Ryan", "Microsoft George", "Alex", "Aaron"];
function pickVoice() {
  const voices = synth?.getVoices() ?? [];
  if (!voices.length) return null;
  for (const name of PREFERRED) {
    const v = voices.find((v) => v.name.startsWith(name) && v.lang.startsWith("en"));
    if (v) return v;
  }
  return voices.find((v) => v.lang === "en-GB") ?? voices.find((v) => v.lang.startsWith("en")) ?? voices[0];
}
synth?.addEventListener?.("voiceschanged", () => (voice = pickVoice()));

function speakBrowser(text: string) {
  if (!synth) return;
  const u = new SpeechSynthesisUtterance(text);
  voice ??= pickVoice();
  if (voice) u.voice = voice;
  u.rate = 1.04;
  u.pitch = 0.92;
  u.onstart = started;
  u.onend = u.onerror = ended;
  synth.speak(u);
}

function speak(raw: string) {
  const text = speakable(raw);
  if (!enabled || !/[a-z0-9]/i.test(text)) return;
  if (engine === "hq") speakHq(text);
  else speakBrowser(text);
}

export const tts = {
  /** Feed streamed text; complete sentences are spoken immediately. */
  feed(text: string) {
    if (!enabled) return;
    // rewrite the name before splitting, so "G.A.R.T.H. is…" isn't cut at its dots
    buffer = speakName(buffer + text);
    for (;;) {
      const m = buffer.match(/^[\s\S]*?(?:[.!?…:;](?=\s)|\n)/);
      if (!m || m[0].trim().length < 2) break;
      // "GARTH." may end the sentence or just the abbreviation: wait for the next character to tell
      if (/GARTH\.$/.test(m[0]) && !/\S/.test(buffer.slice(m[0].length))) break;
      speak(m[0]);
      buffer = buffer.slice(m[0].length);
    }
  },
  /** Speak whatever is left (end of a message). */
  flush() {
    if (buffer.trim()) speak(buffer);
    buffer = "";
  },
  stop() {
    generation++;
    buffer = "";
    for (const ac of inflight) ac.abort();
    inflight.clear();
    for (const s of sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    sources.clear();
    chain = Promise.resolve();
    playhead = 0;
    synth?.cancel();
    active = 0;
    emit();
  },
  get enabled() {
    return enabled;
  },
  get engine() {
    return engine;
  },
  setEnabled(on: boolean) {
    enabled = on;
    if (!on) this.stop();
  },
  available: !!synth || typeof AudioContext !== "undefined",
  onSpeaking(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
