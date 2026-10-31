import { create } from "zustand";
import type { HqToUi, Snapshot } from "@hq/protocol";
import { tts } from "./tts";

export type Selection = { kind: "hq" } | { kind: "outpost"; id: string } | { kind: "task"; id: string } | { kind: "agent"; id: string } | null;

interface UiState {
  state: Snapshot | null;
  connected: boolean;
  streaming: string; // G.A.R.T.H. text currently being generated
  activity: string; // what G.A.R.T.H. is doing right now (tool call), if anything
  voiceSpeaking: boolean;
  voiceOn: boolean;
  selected: Selection;
  select(s: Selection): void;
  setVoice(on: boolean): void;
}

export const useStore = create<UiState>((set) => ({
  state: null,
  connected: false,
  streaming: "",
  activity: "",
  voiceSpeaking: false,
  voiceOn: tts.enabled,
  selected: null,
  select: (selected) => set({ selected }),
  setVoice: (on) => {
    tts.setEnabled(on);
    set({ voiceOn: on });
  },
}));

tts.onSpeaking((voiceSpeaking) => useStore.setState({ voiceSpeaking }));

export function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/ui`);
  ws.onopen = () => useStore.setState({ connected: true });
  ws.onclose = () => {
    useStore.setState({ connected: false });
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as HqToUi;
    if (msg.type === "snapshot") {
      useStore.setState((s) => {
        const prev = s.state?.garth.transcript;
        const next = msg.state.garth.transcript;
        // a completed G.A.R.T.H. message landed in the transcript: the stream it came from is done
        const committed = !!prev && next.length && prev[prev.length - 1]?.id !== next[next.length - 1]?.id && next[next.length - 1].role === "garth";
        if (committed) tts.flush();
        const idle = msg.state.garth.state === "idle" || msg.state.garth.state === "alert";
        if (idle) tts.flush();
        return { state: msg.state, streaming: committed || idle ? "" : s.streaming };
      });
    } else if (msg.type === "garth.delta") {
      tts.feed(msg.text);
      useStore.setState((s) => ({ streaming: s.streaming + msg.text, activity: "" }));
    } else if (msg.type === "garth.activity") {
      useStore.setState({ activity: msg.text });
    }
  };
}

export async function post(path: string, body?: unknown) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error ?? r.statusText);
  return j;
}
