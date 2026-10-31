import type { Edge, Node } from "@xyflow/react";
import type { Agent, Outpost, Snapshot, Task } from "@hq/protocol";

export type HqNode = Node<{ name: string; garthState: string; online: number }, "hq">;
export type OutpostNode = Node<{ outpost: Outpost; active: number }, "outpost">;
export type TaskNode = Node<{ task: Task; agent?: Agent }, "task">;
export type AgentNode = Node<{ agent: Agent }, "agent">;
export type AnyNode = HqNode | OutpostNode | TaskNode | AgentNode;

const RECENT_MS = 10 * 60_000;
const R_OUTPOST = 380;
const R_LOCAL = 210;
const R_CLOUD = 330;

/** Radial layout: HQ in the centre, outposts on a ring, each outpost's work fanned out away from HQ. */
export function layout(s: Snapshot): { nodes: AnyNode[]; edges: Edge[] } {
  const nodes: AnyNode[] = [];
  const edges: Edge[] = [];
  const now = Date.now();

  nodes.push({ id: "hq", type: "hq", position: { x: 0, y: 0 }, data: { name: s.hq.name, garthState: s.garth.state, online: s.outposts.filter((o) => o.status === "online").length } });

  const outposts = [...s.outposts].sort((a, b) => Number(b.embedded) - Number(a.embedded) || a.name.localeCompare(b.name));
  const n = Math.max(outposts.length, 1);

  outposts.forEach((o, i) => {
    const angle = -Math.PI / 2 + (i / n) * Math.PI * 2 + (n === 1 ? Math.PI : 0);
    const ox = Math.cos(angle) * R_OUTPOST;
    const oy = Math.sin(angle) * R_OUTPOST;

    const tasks = s.tasks.filter((t) => t.outpostId === o.id && (isActive(t) || now - t.updatedAt < RECENT_MS));
    const agentByTask = new Map(s.agents.filter((a) => a.taskId).map((a) => [a.taskId!, a]));
    const orphanAgents = s.agents.filter((a) => a.outpostId === o.id && (!a.taskId || !s.tasks.some((t) => t.id === a.taskId)));

    nodes.push({ id: o.id, type: "outpost", position: { x: ox, y: oy }, data: { outpost: o, active: tasks.filter(isActive).length } });
    edges.push({ id: `hq-${o.id}`, source: "hq", target: o.id, animated: o.status === "online", className: o.status === "online" ? "" : "offline" });

    const local = [...tasks.filter((t) => t.lane === "local"), ...orphanAgents.filter((a) => a.lane === "local")];
    const cloud = [...tasks.filter((t) => t.lane === "cloud"), ...orphanAgents.filter((a) => a.lane === "cloud")];
    fan(local, angle, ox, oy, R_LOCAL);
    fan(cloud, angle, ox, oy, R_CLOUD);

    function fan(items: Array<Task | Agent>, base: number, cx: number, cy: number, r: number) {
      // keep ~210px of arc between siblings; overflow onto outer rows
      const perRow = Math.max(1, Math.floor((Math.PI * 0.9 * r) / 210) + 1);
      items.forEach((it, j) => {
        const row = Math.floor(j / perRow);
        const col = j % perRow;
        const count = Math.min(perRow, items.length - row * perRow);
        const rr = r + row * 120;
        const step = 210 / rr;
        const a = base + (count === 1 ? 0 : (col - (count - 1) / 2) * step);
        const pos = { x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr };
        if ("instruction" in it) {
          const agent = agentByTask.get(it.id);
          nodes.push({ id: it.id, type: "task", position: pos, data: { task: it, agent } });
          edges.push({ id: `${o.id}-${it.id}`, source: o.id, target: it.id, animated: it.status === "running", className: [it.lane === "cloud" ? "cloud" : "", it.status === "running" ? "running" : ""].join(" ") });
        } else {
          nodes.push({ id: it.id, type: "agent", position: pos, data: { agent: it } });
          edges.push({ id: `${o.id}-${it.id}`, source: o.id, target: it.id, animated: it.status === "running", className: it.lane === "cloud" ? "cloud" : "" });
        }
      });
    }
  });

  return { nodes, edges };
}

const isActive = (t: Task) => t.status === "queued" || t.status === "running" || t.status === "needs_input";
