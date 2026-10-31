import type { Edge, Node } from "@xyflow/react";

export type ConduitData = { kind: "link" | "cloud" | "offline"; active: boolean; trimStart?: number };
export type ConduitEdge = Edge<ConduitData, "conduit">;
import type { Agent, Outpost, Snapshot, Task } from "@hq/protocol";

export type HqNode = Node<{ name: string; garthState: string; online: number; outpost?: Outpost }, "hq">;
export type OutpostNode = Node<{ outpost: Outpost; active: number }, "outpost">;
export type TaskNode = Node<{ task: Task; agent?: Agent }, "task">;
export type AgentNode = Node<{ agent: Agent }, "agent">;
export type AnyNode = HqNode | OutpostNode | TaskNode | AgentNode;

const RECENT_MS = 10 * 60_000;
const R_OUTPOST = 460;
const HUB_RIM = 178; // G.A.R.T.H. core radius: conduits start at its bezel, not its centre
const R_LOCAL = 300;
const R_CLOUD = 480;
// work on the HQ machine itself fans straight out from the hub (its outpost is part of HQ, not a separate node)
const R_HQ_LOCAL = 400;
const R_HQ_CLOUD = 580;

/** Radial layout: HQ in the centre, outposts on a ring, each outpost's work fanned out away from HQ. */
export function layout(s: Snapshot): { nodes: AnyNode[]; edges: ConduitEdge[] } {
  const nodes: AnyNode[] = [];
  const edges: ConduitEdge[] = [];
  const link = (id: string, source: string, target: string, kind: ConduitData["kind"], active: boolean): ConduitEdge => ({
    id, source, target, type: "conduit", data: { kind, active, trimStart: source === "hq" ? HUB_RIM : 0 },
  });
  const now = Date.now();

  // the HQ machine's own outpost is part of HQ: no separate node, its work hangs off the hub
  const home = s.outposts.find((o) => o.embedded);
  nodes.push({
    id: "hq", type: "hq", position: { x: 0, y: 0 },
    data: { name: s.hq.name, garthState: s.garth.state, online: s.outposts.filter((o) => o.status === "online").length, outpost: home },
  });

  const agentByTask = new Map(s.agents.filter((a) => a.taskId).map((a) => [a.taskId!, a]));
  // any outpost running on the HQ machine (e.g. a standalone one started alongside HQ) is part of HQ too
  const onHq = (o: Outpost) => o.embedded || (!!home && o.hostname === home.hostname);
  const remote = s.outposts.filter((o) => !onHq(o)).sort((a, b) => a.name.localeCompare(b.name));
  const n = remote.length;

  /** Fan an outpost's local and cloud work out from (cx, cy) along `angle`, linked to node `from`. */
  function work(o: Outpost, from: string, angle: number, cx: number, cy: number, rLocal: number, rCloud: number) {
    const tasks = s.tasks.filter((t) => t.outpostId === o.id && (isActive(t) || now - t.updatedAt < RECENT_MS));
    const orphanAgents = s.agents.filter((a) => a.outpostId === o.id && (!a.taskId || !s.tasks.some((t) => t.id === a.taskId)));
    const local = [...tasks.filter((t) => t.lane === "local"), ...orphanAgents.filter((a) => a.lane === "local")];
    const cloud = [...tasks.filter((t) => t.lane === "cloud"), ...orphanAgents.filter((a) => a.lane === "cloud")];
    fan(local, rLocal);
    fan(cloud, rCloud);
    return tasks;

    function fan(items: Array<Task | Agent>, r: number) {
      // keep ~210px of arc between siblings; overflow onto outer rows
      const perRow = Math.max(1, Math.floor((Math.PI * 0.9 * r) / 210) + 1);
      items.forEach((it, j) => {
        const row = Math.floor(j / perRow);
        const col = j % perRow;
        const count = Math.min(perRow, items.length - row * perRow);
        const rr = r + row * 120;
        const step = 210 / rr;
        const a = angle + (count === 1 ? 0 : (col - (count - 1) / 2) * step);
        const pos = { x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr };
        const kind = it.lane === "cloud" ? "cloud" : "link";
        if ("instruction" in it) nodes.push({ id: it.id, type: "task", position: pos, data: { task: it, agent: agentByTask.get(it.id) } });
        else nodes.push({ id: it.id, type: "agent", position: pos, data: { agent: it } });
        edges.push(link(`${from}-${it.id}`, from, it.id, kind, it.status === "running"));
      });
    }
  }

  remote.forEach((o, i) => {
    const angle = (i / Math.max(n, 1)) * Math.PI * 2;
    const ox = Math.cos(angle) * R_OUTPOST;
    const oy = Math.sin(angle) * R_OUTPOST;
    const tasks = work(o, o.id, angle, ox, oy, R_LOCAL, R_CLOUD);
    nodes.push({ id: o.id, type: "outpost", position: { x: ox, y: oy }, data: { outpost: o, active: tasks.filter(isActive).length } });
    edges.push(link(`hq-${o.id}`, "hq", o.id, o.status === "online" ? "link" : "offline", tasks.some(isActive)));
  });

  // HQ's own work goes in the widest gap between remote outposts (opposite the only one, or rightward if none)
  for (const o of s.outposts.filter(onHq)) work(o, "hq", n ? Math.PI / n : 0, 0, 0, R_HQ_LOCAL, R_HQ_CLOUD);

  return { nodes, edges };
}

const isActive = (t: Task) => t.status === "queued" || t.status === "running" || t.status === "needs_input";
