import { create } from "zustand";
import type { HqToUi, Snapshot } from "@hq/protocol";

export type Selection = { kind: "hq" } | { kind: "outpost"; id: string } | { kind: "task"; id: string } | { kind: "agent"; id: string } | null;

interface UiState {
  state: Snapshot | null;
  connected: boolean;
  streaming: string; // G.A.R.T.H. text currently being generated
  selected: Selection;
  select(s: Selection): void;
}

export const useStore = create<UiState>((set) => ({
  state: null,
  connected: false,
  streaming: "",
  selected: null,
  select: (selected) => set({ selected }),
}));

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
      useStore.setState((s) => ({ state: msg.state, streaming: msg.state.garth.state === "speaking" ? s.streaming : "" }));
    } else if (msg.type === "garth.delta") {
      useStore.setState((s) => ({ streaming: s.streaming + msg.text }));
    }
    // task.event: snapshot follows within ~30ms, nothing to do here
  };
}

export async function post(path: string, body?: unknown) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error ?? r.statusText);
  return j;
}
