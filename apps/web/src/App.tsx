import { Command } from "./components/Command";
import { Inspector } from "./components/Inspector";
import { Graph } from "./graph/Graph";
import { useStore } from "./store";

export function App() {
  const { state, connected, selected, select } = useStore();
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
      <Command />
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
