import { create } from "zustand";
import type { ChannelView, HqToUi, Snapshot } from "@hq/protocol";
import { tts } from "./tts";

export type Selection = { kind: "hq" } | { kind: "outpost"; id: string } | { kind: "task"; id: string } | { kind: "agent"; id: string } | null;

interface UiState {
  state: Snapshot | null;
  connected: boolean;
  streaming: string; // G.A.R.T.H. text currently being generated
  activity: string; // what G.A.R.T.H. is doing right now (tool call), if anything
  voiceSpeaking: boolean;
  voiceOn: boolean;
  activeChannelId: string | null; // the channel the operator is looking at (remembered per browser)
  selected: Selection;
  select(s: Selection): void;
  setVoice(on: boolean): void;
  setChannel(id: string): void;
}

const savedChannel = () => {
  try {
    return localStorage.getItem("garth.channel");
  } catch {
    return null;
  }
};

/** The active channel: the chosen one if it still exists, else General, else the most recent. */
export function activeChannelOf(s: { state: Snapshot | null; activeChannelId: string | null }): ChannelView | undefined {
  const chs = s.state?.garth.channels ?? [];
  return chs.find((c) => c.id === s.activeChannelId) ?? chs.find((c) => c.id === "general") ?? chs[0];
}

export const useStore = create<UiState>((set) => ({
  state: null,
  connected: false,
  streaming: "",
  activity: "",
  voiceSpeaking: false,
  voiceOn: tts.enabled,
  activeChannelId: savedChannel(),
  selected: null,
  select: (selected) => set({ selected }),
  setChannel: (id) => {
    try {
      localStorage.setItem("garth.channel", id);
    } catch {
      /* private mode */
    }
    tts.stop();
    set({ activeChannelId: id, streaming: "", activity: "" });
  },
  setVoice: (on) => {
    tts.setEnabled(on);
    set({ voiceOn: on });
  },
}));

tts.onSpeaking((voiceSpeaking) => useStore.setState({ voiceSpeaking }));

/** Settings are defaults for a page load: apply the startup channel and voice once, on the first snapshot. */
let startupApplied = false;
function applyStartup(snap: Snapshot) {
  if (startupApplied) return;
  startupApplied = true;
  const { settings, garth } = snap;
  useStore.getState().setVoice(settings.voiceOn);
  const go = useStore.getState().setChannel;
  const pick = settings.startupChannel;
  if (pick === "last") return; // keep the channel remembered by this browser
  if (pick === "general") return go("general");
  if (pick === "new") {
    // reuse an untouched new channel rather than piling up empty ones
    const empty = garth.channels.find((c) => c.name === "New channel" && c.transcript.length === 0);
    if (empty) return go(empty.id);
    post("/api/channels", {}).then((c: { id: string }) => go(c.id)).catch(() => {});
    return;
  }
  if (garth.channels.some((c) => c.id === pick)) go(pick);
}

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
      applyStartup(msg.state);
      useStore.setState((s) => {
        const prev = activeChannelOf(s);
        const next = activeChannelOf({ state: msg.state, activeChannelId: s.activeChannelId });
        const pt = prev?.transcript ?? [];
        const nt = next?.transcript ?? [];
        // a completed G.A.R.T.H. message landed in the active channel: the stream it came from is done
        const committed = prev?.id === next?.id && nt.length > 0 && pt.at(-1)?.id !== nt.at(-1)?.id && nt.at(-1)!.role === "garth";
        const idle = next?.state === "idle";
        if (committed || idle) tts.flush();
        return { state: msg.state, streaming: committed || idle ? "" : s.streaming };
      });
    } else if (msg.type === "garth.delta") {
      if (msg.channelId !== activeChannelOf(useStore.getState())?.id) return; // other channels speak only in their own view
      tts.feed(msg.text);
      useStore.setState((s) => ({ streaming: s.streaming + msg.text, activity: "" }));
    } else if (msg.type === "garth.activity") {
      if (msg.channelId !== activeChannelOf(useStore.getState())?.id) return;
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
