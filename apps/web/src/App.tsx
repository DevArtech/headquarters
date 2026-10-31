import { Garth } from "./components/Garth";
import { Inbox } from "./components/Inbox";
import { Inspector } from "./components/Inspector";
import { Graph } from "./graph/Graph";
import { useStore } from "./store";

export function App() {
  const { state, connected } = useStore();
  const online = state?.outposts.filter((o) => o.status === "online").length ?? 0;
  const running = state?.tasks.filter((t) => t.status === "running" || t.status === "needs_input").length ?? 0;
  const cloud = state?.agents.filter((a) => a.lane === "cloud").length ?? 0;
  const unread = state?.notifications.filter((n) => !n.read).length ?? 0;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">◈ Headquarters</span>
        <span className="stat"><i className={`dot ${connected ? "on" : "off"}`} />{connected ? "link up" : "link down"}</span>
        <span className="stat">outposts <b>{online}</b>/{state?.outposts.length ?? 0}</span>
        <span className="stat">active tasks <b>{running}</b></span>
        <span className="stat">cloud agents <b>{cloud}</b></span>
        <span className="spacer" />
        <span className="stat">inbox <b>{unread}</b></span>
        <span className="stat">{state?.hq.name}</span>
      </header>
      <aside className="panel"><Garth /></aside>
      <main className="graph"><Graph /></main>
      <aside className="panel right">
        <h2>Inbox</h2>
        <div className="scroll" style={{ flex: "0 1 45%" }}><Inbox /></div>
        <h2>Inspector</h2>
        <div className="scroll"><Inspector /></div>
      </aside>
    </div>
  );
}
