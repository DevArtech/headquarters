import type { GarthBrainKind, Snapshot } from "@hq/protocol";

/**
 * What G.A.R.T.H.'s core visualises, derived from HQ's state. Every element of the 3D core reads one
 * of these; nothing in it is purely decorative.
 */
export interface Vitals {
  /** Brains installed on HQ: the polyhedra inside the core. */
  brains: Array<{ kind: GarthBrainKind; current: boolean; busy: number }>;
  /** Channels mid-turn: churn of the plasma surface. */
  busyChannels: number;
  /** HQ machine's CPU load 0–1 and last heartbeat: the geodesic shell. */
  hq: { load: number; beat: number } | null;
  /** Other devices: ring 1 satellites and arcs; their average load fills ring 1's dial. */
  fleet: Array<{ id: string; online: boolean; load: number }>;
  fleetLoad: number;
  /** Work in progress with start times: ring 2 (on the HQ machine) and ring 3 (cloud lane). */
  local: Array<{ id: string; started: number; waiting: boolean }>;
  cloud: Array<{ id: string; started: number; waiting: boolean }>;
  /** Notifications: blips on the radar (decisions pulse). */
  notes: Array<{ id: string; ts: number; kind: 0 | 1 | 2 | 3 }>;
  /** Event timestamps from the last 8 minutes: the bar ring when silent, and the particle flow. */
  events: number[];
  /** Live status line on the legend band. */
  ticker: string;
  /** Things that just happened, for ripples (diffed between readings by the core). */
  marks: { notes: string[]; taskStates: string[]; lastMessage: string; beat: number };
}

const BRAIN: Record<GarthBrainKind, string> = { "claude-code": "CLAUDE CODE", codex: "CODEX", antigravity: "ANTIGRAVITY", api: "CLAUDE API" };
const HISTORY_MS = 8 * 60_000;
const plural = (n: number, one: string, many = one + "S") => `${n} ${n === 1 ? one : many}`;

export function deriveVitals(s: Snapshot, activeChannelId: string | undefined, now = Date.now()): Vitals {
  const channels = s.garth.channels;
  const active = channels.find((c) => c.id === activeChannelId) ?? channels[0];
  const busy = channels.filter((c) => c.state !== "idle");

  const brains = s.garth.brains.map((kind) => ({
    kind,
    current: active?.brain === kind,
    busy: busy.filter((c) => c.brain === kind).length,
  }));

  // the HQ machine (its embedded outpost, or any outpost on the same host) vs other devices
  const home = s.outposts.find((o) => o.embedded);
  const onHq = (o: (typeof s.outposts)[number]) => o.embedded || (!!home && o.hostname === home.hostname);
  const fleet = s.outposts
    .filter((o) => !onHq(o))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((o) => ({ id: o.id, online: o.status === "online", load: Math.min(1, o.load ?? 0) }));
  const online = fleet.filter((o) => o.online);
  const fleetLoad = online.length ? online.reduce((a, o) => a + o.load, 0) / online.length : 0;
  const hqOutposts = new Set(s.outposts.filter(onHq).map((o) => o.id));

  const working = s.tasks.filter((t) => t.status === "running" || t.status === "queued" || t.status === "needs_input");
  const local = working.filter((t) => t.lane === "local" && hqOutposts.has(t.outpostId)).map((t) => ({ id: t.id, started: t.createdAt, waiting: t.status === "needs_input" }));
  const cloud = [
    ...working.filter((t) => t.lane === "cloud").map((t) => ({ id: t.id, started: t.createdAt, waiting: t.status === "needs_input" })),
    ...s.agents.filter((a) => a.lane === "cloud" && !a.taskId).map((a) => ({ id: a.id, started: a.startedAt, waiting: a.status === "waiting" })),
  ];

  const notes = s.notifications
    .filter((n) => (n.decision && !n.decision.answer) || !n.read)
    .slice(0, 12)
    .map((n) => ({ id: n.id, ts: n.ts, kind: (n.decision && !n.decision.answer ? 3 : n.level === "error" || n.level === "warn" ? 2 : n.level === "success" ? 1 : 0) as 0 | 1 | 2 | 3 }));
  const decisions = notes.filter((n) => n.kind === 3).length;
  const unread = notes.length - decisions;

  const since = now - HISTORY_MS;
  const events: number[] = [];
  for (const t of s.tasks) for (const e of t.events) if (e.ts > since) events.push(e.ts);
  for (const c of channels) for (const m of c.transcript) if (m.ts > since) events.push(m.ts);
  for (const n of s.notifications) if (n.ts > since) events.push(n.ts);
  events.sort((a, b) => a - b);

  const running = working.filter((t) => t.status === "running").length;
  const attention = decisions ? plural(decisions, "DECISION WAITING", "DECISIONS WAITING") : unread ? plural(unread, "UNREAD NOTICE") : "ALL CLEAR";
  const ticker = [
    "G.A.R.T.H.",
    `${plural(online.length + (home?.status === "online" ? 1 : 0), "OUTPOST")} ONLINE`,
    `${plural(running, "TASK")} RUNNING`,
    ...(cloud.length ? [`${cloud.length} IN CLOUD`] : []),
    attention,
    active ? `#${active.name.toUpperCase()} · ${BRAIN[active.brain]}` : "",
    home ? `HQ LOAD ${Math.round(Math.min(1, home.load ?? 0) * 100)}%` : "",
  ]
    .filter(Boolean)
    .join("  ◆  ");

  return {
    brains,
    busyChannels: busy.length,
    hq: home ? { load: Math.min(1, home.load ?? 0), beat: home.lastSeen } : null,
    fleet,
    fleetLoad,
    local,
    cloud,
    notes,
    events,
    ticker: ticker + "  ◆  ",
    marks: {
      notes: s.notifications.map((n) => n.id),
      taskStates: s.tasks.map((t) => `${t.id}:${t.status}`),
      lastMessage: active?.transcript.at(-1)?.id ?? "",
      beat: home?.lastSeen ?? 0,
    },
  };
}

/**
 * The tooltip on the core: what each part means.
 */
export const ORB_KEY = [
  "G.A.R.T.H. core",
  "Plasma: G.A.R.T.H. (swells with its voice; churns with channels at work)",
  "Inner shapes: installed brains (brightest = this channel's; spinning = mid-reply)",
  "Dotted shell: the HQ machine (brightness = CPU load; flash = heartbeat)",
  "Ring 1: other devices (satellite per outpost; ticks = average load)",
  "Ring 2: tasks on HQ (advance one tick per 5 s, one lap = 10 min; amber = needs you)",
  "Ring 3: cloud tasks (same clock)",
  "Band: live status",
  "Radar: notifications (amber pulse = decision waiting)",
  "Bars: voice while speaking, else the last 8 minutes of activity",
  "Particles: event flow  ·  Ripples: something just happened",
].join("\n");
