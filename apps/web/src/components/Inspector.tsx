import { useEffect, useState } from "react";
import type { Harness, Outpost, Task } from "@hq/protocol";
import { post, useStore } from "../store";

export function Inspector() {
  const state = useStore((s) => s.state);
  const sel = useStore((s) => s.selected);
  if (!state || !sel || sel.kind === "hq") return null;
  if (sel.kind === "outpost") {
    const o = state.outposts.find((x) => x.id === sel.id);
    return o ? <OutpostView o={o} /> : null;
  }
  if (sel.kind === "task") {
    const t = state.tasks.find((x) => x.id === sel.id);
    return t ? <TaskView t={t} /> : null;
  }
  const a = state.agents.find((x) => x.id === sel.id);
  return a ? (
    <div className="inspector">
      <div className="h">{a.title ?? a.id}</div>
      <Row k="harness" v={a.harness} /><Row k="lane" v={a.lane} /><Row k="status" v={a.status} /><Row k="session" v={a.sessionId ?? "—"} />
    </div>
  ) : null;
}

const Row = ({ k, v }: { k: string; v: string }) => <div className="row"><span>{k}</span><b>{v}</b></div>;

function TaskView({ t }: { t: Task }) {
  const [reply, setReply] = useState("");
  const active = t.status === "running" || t.status === "needs_input" || t.status === "queued";
  return (
    <div className="inspector">
      <div className="h">{t.title}</div>
      <Row k="status" v={t.status} />
      <Row k="where" v={`${t.harness} · ${t.lane}`} />
      <Row k="cwd" v={t.cwd ?? "~"} />
      <Row k="id" v={t.id} />
      <pre>{t.instruction}</pre>
      {t.result && <><div className="row"><span>result</span></div><pre>{t.result}</pre></>}
      {t.error && <><div className="row"><span>error</span></div><pre style={{ color: "var(--red)" }}>{t.error}</pre></>}
      <div className="row"><span>events ({t.events.length})</span></div>
      <div className="events">
        {t.events.slice(-60).map((e, i) => (
          <div key={i} className={`ev ${e.type}`}><span className="k">{e.type}</span>{fmt(e.payload)}</div>
        ))}
      </div>
      {active && (
        <div className="form">
          <textarea placeholder="Send a follow-up to this agent…" value={reply} onChange={(e) => setReply(e.target.value)} />
          <div className="actions">
            <button className="btn" disabled={!reply.trim() || !t.agentId} onClick={() => (post(`/api/tasks/${t.id}/send`, { text: reply }).catch((e) => alert(e.message)), setReply(""))}>Send</button>
            <button className="btn danger" onClick={() => post(`/api/tasks/${t.id}/cancel`)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function OutpostView({ o }: { o: Outpost }) {
  const [dir, setDir] = useState(o.home);
  const [entries, setEntries] = useState<Array<{ name: string; dir: boolean }>>([]);
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);
  useEffect(() => {
    setFile(null);
    post(`/api/outposts/${o.id}/fs`, { op: "list", path: dir }).then(setEntries).catch(() => setEntries([]));
  }, [dir, o.id, o.status]);
  const parent = dir.replace(/\/[^/]+\/?$/, "") || "/";
  return (
    <div className="inspector">
      <div className="h">{o.name}</div>
      <Row k="status" v={o.status} />
      <Row k="platform" v={o.platform} />
      <Row k="harnesses" v={o.harnesses.map((h) => `${h.id}${h.available ? "" : " (missing)"}`).join(", ")} />
      <div className="row"><span>files</span><b>{dir}</b></div>
      <div className="files">
        <div className="d" onClick={() => setDir(parent)}>↑ ..</div>
        {entries.map((e) => (
          <div key={e.name} className={e.dir ? "d" : ""} onClick={() => (e.dir ? setDir(`${dir.replace(/\/$/, "")}/${e.name}`) : post(`/api/outposts/${o.id}/fs`, { op: "read", path: `${dir.replace(/\/$/, "")}/${e.name}`, }).then((r) => setFile({ path: e.name, content: r.content })))}>
            {e.dir ? "▸ " : "· "}{e.name}
          </div>
        ))}
      </div>
      {file && <><div className="row"><span>{file.path}</span></div><pre>{file.content.slice(0, 6000)}</pre></>}
      <QuickDispatch outposts={[o]} cwd={dir} />
    </div>
  );
}

function QuickDispatch({ outposts, cwd }: { outposts: Outpost[]; cwd?: string }) {
  const online = outposts.filter((o) => o.status === "online");
  const [outpostId, setOutpostId] = useState(online[0]?.id ?? "");
  const [harness, setHarness] = useState<Harness>("claude");
  const [lane, setLane] = useState<"local" | "cloud">("local");
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  useEffect(() => { if (!online.some((o) => o.id === outpostId)) setOutpostId(online[0]?.id ?? ""); }, [outposts]);
  const go = () =>
    post("/api/tasks", { title: title || instruction.slice(0, 50), instruction, outpostId, harness, lane, cwd })
      .then(() => (setTitle(""), setInstruction("")))
      .catch((e) => alert(e.message));
  return (
    <div className="form">
      <div className="row"><span>dispatch directly</span></div>
      <select value={outpostId} onChange={(e) => setOutpostId(e.target.value)}>{online.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
      <div style={{ display: "flex", gap: 6 }}>
        <select value={harness} onChange={(e) => setHarness(e.target.value as Harness)} style={{ flex: 1 }}><option value="claude">claude</option><option value="codex">codex</option><option value="shell">shell</option></select>
        <select value={lane} onChange={(e) => setLane(e.target.value as "local")} style={{ flex: 1 }}><option value="local">local</option><option value="cloud">cloud</option></select>
      </div>
      <input placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea placeholder={harness === "shell" ? "Command to run" : "Instruction for the agent"} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
      <button className="btn" disabled={!instruction.trim() || !outpostId} onClick={go}>Dispatch</button>
    </div>
  );
}

function fmt(p: unknown): string {
  if (p == null) return "";
  if (typeof p === "string") return p.length > 400 ? p.slice(0, 400) + "…" : p;
  const s = JSON.stringify(p);
  return s.length > 400 ? s.slice(0, 400) + "…" : s;
}
