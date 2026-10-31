import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { AgentNode, HqNode, OutpostNode, TaskNode } from "./layout";

const handles = (
  <>
    <Handle type="target" position={Position.Top} />
    <Handle type="source" position={Position.Bottom} />
  </>
);

export function HqNodeView({ data }: NodeProps<HqNode>) {
  return (
    <div className="node hq">
      {handles}
      <div className="kind">◈ Headquarters</div>
      <div className="title">{data.name}</div>
      <div className="meta" style={{ justifyContent: "center" }}>
        <span className="chip on">G.A.R.T.H. {data.garthState}</span>
        <span className="chip">{data.online} online</span>
      </div>
    </div>
  );
}

export function OutpostNodeView({ data }: NodeProps<OutpostNode>) {
  const o = data.outpost;
  return (
    <div className={`node outpost ${o.status} ${o.embedded ? "embedded" : ""}`}>
      {handles}
      <div className="kind"><i className={`dot ${o.status === "online" ? "on" : "off"}`} />{o.embedded ? "Local outpost" : "Outpost"}</div>
      <div className="title">{o.name}</div>
      <div className="meta">
        {o.harnesses.filter((h) => h.available).map((h) => <span key={h.id} className="chip on">{h.id}</span>)}
        {data.active > 0 && <span className="chip">{data.active} active</span>}
      </div>
    </div>
  );
}

export function TaskNodeView({ data }: NodeProps<TaskNode>) {
  const t = data.task;
  const running = t.status === "running";
  const last = [...t.events].reverse().find((e) => e.type === "tool_use" || e.type === "text");
  const hint = last ? (last.type === "tool_use" ? `⚙ ${(last.payload as { name?: string })?.name ?? "tool"}` : String(last.payload).slice(0, 48)) : "";
  return (
    <div className={`node task ${t.lane} ${t.status}`}>
      {handles}
      <div className="kind">{t.lane === "cloud" ? "☁ cloud" : "▣ local"} · {t.harness}</div>
      <div className="title" title={t.title}>{t.title}</div>
      <div className="meta">
        <span className={`status ${t.status}`}>{t.status.replace("_", " ")}</span>
        {t.createdBy === "garth" && <span className="chip">via G.A.R.T.H.</span>}
      </div>
      {hint && <div className="meta" style={{ opacity: 0.8 }}>{hint}</div>}
      {running && <span className="ticker" />}
    </div>
  );
}

export function AgentNodeView({ data }: NodeProps<AgentNode>) {
  const a = data.agent;
  return (
    <div className="node agent">
      {handles}
      <div className="kind">{a.lane === "cloud" ? "☁ cloud session" : "▣ session"} · {a.harness}</div>
      <div className="title">{a.title ?? a.sessionId ?? a.id}</div>
      <div className="meta"><span className={`status ${a.status}`}>{a.status}</span></div>
    </div>
  );
}

export const nodeTypes = { hq: HqNodeView, outpost: OutpostNodeView, task: TaskNodeView, agent: AgentNodeView };
