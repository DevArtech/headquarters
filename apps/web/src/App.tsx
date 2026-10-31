import { Command } from "./components/Command";
import { Inspector } from "./components/Inspector";
import { SettingsPanel } from "./components/Settings";
import { useEffect, useState } from "react";
import { Graph } from "./graph/Graph";
import { useStore } from "./store";

export function App() {
  const { state, connected, selected, select } = useStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const inspecting = !!selected && selected.kind !== "hq";
  const showSettings = settingsOpen && !inspecting; // a selected node's inspector takes the panel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSettingsOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const online = state?.outposts.filter((o) => o.status === "online").length ?? 0;
  const active = state?.tasks.filter((t) => t.status === "running" || t.status === "needs_input").length ?? 0;

  return (
    <div className="stage">
      <Graph />
      <div className="corner">
        <span className="mark">◈ HQ</span>
        <i className={`led ${connected ? "online" : "offline"}`} />
        <span>{online} outpost{online === 1 ? "" : "s"}</span>
        <span>{active} active</span>
      </div>
      {!inspecting && (
      <button
        className={`gear ${showSettings ? "on" : ""}`}
        title={showSettings ? "Close settings (Esc)" : "Settings"}
        aria-label={showSettings ? "Close settings" : "Settings"}
        onClick={() => setSettingsOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            fill="currentColor"
            d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
            transform="translate(-1 0)"
          />
        </svg>
      </button>
      )}
      <Command />
      {showSettings && (
        <aside className="drawer">
          <SettingsPanel />
        </aside>
      )}
      {selected && selected.kind !== "hq" && (
        <aside className="drawer">
          <button className="close" onClick={() => select(null)} aria-label="Close">×</button>
          <Inspector />
        </aside>
      )}
      <div className="grain" />
    </div>
  );
}
