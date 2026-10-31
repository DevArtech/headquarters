import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { TaskStatus } from "@hq/protocol";
import { Orb } from "../components/Orb";
import type { AgentNode, HqNode, OutpostNode, TaskNode } from "./layout";

const CENTER = { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
const handles = (
  <>
    <Handle type="target" position={Position.Top} style={CENTER} />
    <Handle type="source" position={Position.Bottom} style={CENTER} />
  </>
);

const GARTH_STATE: Record<string, string> = {
  idle: "standing by",
  thinking: "routing",
  speaking: "transmitting",
  alert: "awaiting your call",
};

const TASK_STATE: Record<TaskStatus, string> = {
  queued: "queued",
  running: "in progress",
  needs_input: "needs you",
  done: "complete",
  failed: "failed",
  cancelled: "cancelled",
};

export function HqNodeView({ data }: NodeProps<HqNode>) {
  return (
    <div className={`hub ${data.garthState}`}>
      {handles}
      <Orb state={data.garthState} size={360} />
      <div className="hub-label">
        <b>G.A.R.T.H.</b>
        <span>{GARTH_STATE[data.garthState] ?? data.garthState}</span>
      </div>
    </div>
  );
}

export function OutpostNodeView({ data }: NodeProps<OutpostNode>) {
  const o = data.outpost;
  const load = Math.max(0.03, Math.min(1, o.load ?? 0));
  return (
    <div className={`node outpost ${o.status}`}>
      {handles}
      <div className="kind">
        <span className="glyph">⬢</span>
        {o.embedded ? "hq outpost" : "outpost"}
        <i className={`led ${o.status}`} />
      </div>
      <div className="title">{o.name.replace(".local", "")}</div>
      <div className="harness">
        {o.harnesses.filter((h) => h.available).map((h) => <span key={h.id}>{h.id}</span>)}
      </div>
      <div className="meter"><i style={{ width: `${load * 100}%` }} /></div>
    </div>
  );
}

export function TaskNodeView({ data }: NodeProps<TaskNode>) {
  const t = data.task;
  return (
    <div className={`node task ${t.lane} ${t.status}`}>
      {handles}
      <div className="kind">
        <span className="glyph">{t.lane === "cloud" ? "☁" : "▣"}</span>
        {t.harness}
        <i className={`led ${t.status}`} />
      </div>
      <div className="title" title={t.title}>{t.title}</div>
      <div className="state">{TASK_STATE[t.status]}</div>
      {t.status === "running" && <div className="scan" />}
    </div>
  );
}

export function AgentNodeView({ data }: NodeProps<AgentNode>) {
  const a = data.agent;
  return (
    <div className={`node task ${a.lane}`}>
      {handles}
      <div className="kind">
        <span className="glyph">{a.lane === "cloud" ? "☁" : "▣"}</span>
        {a.harness} session
        <i className={`led ${a.status}`} />
      </div>
      <div className="title">{a.title ?? a.sessionId ?? a.id}</div>
      <div className="state">{a.status}</div>
    </div>
  );
}

export const nodeTypes = { hq: HqNodeView, outpost: OutpostNodeView, task: TaskNodeView, agent: AgentNodeView };
