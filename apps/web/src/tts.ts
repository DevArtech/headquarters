/**
 * G.A.R.T.H.'s voice: browser speech synthesis fed by the token stream.
 * Text is spoken a sentence at a time as soon as each sentence completes, so the voice starts
 * while G.A.R.T.H. is still generating.
 */
type Listener = (speaking: boolean) => void;

const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
let enabled = read();
let buffer = "";
let active = 0;
let voice: SpeechSynthesisVoice | null = null;
const listeners = new Set<Listener>();

function read() {
  try {
    return localStorage.getItem("garth.voice") !== "off";
  } catch {
    return true;
  }
}

// Prefer a calm British male voice where the platform has one; fall back to any English voice.
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

function emit() {
  for (const l of listeners) l(active > 0);
}

/** Strip what reads badly aloud: markdown, code, URLs, paths. */
function speakable(s: string) {
  return s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/[*_#>|~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function speak(raw: string) {
  const text = speakable(raw);
  if (!synth || !enabled || !/[a-z0-9]/i.test(text)) return;
  const u = new SpeechSynthesisUtterance(text);
  voice ??= pickVoice();
  if (voice) u.voice = voice;
  u.rate = 1.04;
  u.pitch = 0.92;
  u.onstart = () => {
    active++;
    emit();
  };
  u.onend = u.onerror = () => {
    active = Math.max(0, active - 1);
    emit();
  };
  synth.speak(u);
}

export const tts = {
  /** Feed streamed text; complete sentences are spoken immediately. */
  feed(text: string) {
    if (!enabled) return;
    buffer += text;
    for (;;) {
      const m = buffer.match(/^[\s\S]*?(?:[.!?…:;](?=\s)|\n)/);
      if (!m || m[0].trim().length < 2) break;
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
    buffer = "";
    synth?.cancel();
    active = 0;
    emit();
  },
  get enabled() {
    return enabled;
  },
  setEnabled(on: boolean) {
    enabled = on;
    try {
      localStorage.setItem("garth.voice", on ? "on" : "off");
    } catch {
      /* private mode */
    }
    if (!on) this.stop();
  },
  available: !!synth,
  onSpeaking(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
