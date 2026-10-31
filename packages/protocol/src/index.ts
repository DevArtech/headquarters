import { z } from "zod";

// ───────────────────────── Domain model ─────────────────────────

export const Harness = z.enum(["claude", "codex", "shell"]);
export type Harness = z.infer<typeof Harness>;

export const Lane = z.enum(["local", "cloud"]);
export type Lane = z.infer<typeof Lane>;

export const TaskStatus = z.enum(["queued", "running", "needs_input", "done", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const AgentStatus = z.enum(["starting", "running", "waiting", "done", "failed"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const HarnessInfo = z.object({
  id: Harness,
  available: z.boolean(),
  version: z.string().optional(),
  cloud: z.boolean().default(false), // adapter can list/track cloud sessions
});
export type HarnessInfo = z.infer<typeof HarnessInfo>;

export const Outpost = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  hostname: z.string(),
  home: z.string(),
  harnesses: z.array(HarnessInfo),
  status: z.enum(["online", "offline"]),
  lastSeen: z.number(),
  embedded: z.boolean().default(false),
  load: z.number().optional(),
});
export type Outpost = z.infer<typeof Outpost>;

export const Agent = z.object({
  id: z.string(),
  outpostId: z.string(),
  taskId: z.string().optional(),
  harness: Harness,
  lane: Lane,
  status: AgentStatus,
  sessionId: z.string().optional(), // harness-native session id (resume / cloud handle)
  title: z.string().optional(),
  startedAt: z.number(),
  updatedAt: z.number(),
});
export type Agent = z.infer<typeof Agent>;

export const TaskEvent = z.object({
  ts: z.number(),
  type: z.string(), // text | tool_use | tool_result | status | error | result
  payload: z.unknown(),
});
export type TaskEvent = z.infer<typeof TaskEvent>;

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  instruction: z.string(),
  outpostId: z.string(),
  harness: Harness,
  lane: Lane,
  cwd: z.string().optional(),
  status: TaskStatus,
  createdBy: z.enum(["user", "garth"]),
  createdAt: z.number(),
  updatedAt: z.number(),
  agentId: z.string().optional(),
  channelId: z.string().optional(), // G.A.R.T.H. channel that dispatched it; results are reported there
  result: z.string().optional(),
  error: z.string().optional(),
  events: z.array(TaskEvent),
});
export type Task = z.infer<typeof Task>;

export const Notification = z.object({
  id: z.string(),
  ts: z.number(),
  level: z.enum(["info", "success", "warn", "error"]),
  title: z.string(),
  body: z.string().optional(),
  taskId: z.string().optional(),
  channelId: z.string().optional(), // channel a decision's answer is routed back to
  decision: z
    .object({ question: z.string(), options: z.array(z.string()), answer: z.string().optional() })
    .optional(),
  read: z.boolean().default(false),
});
export type Notification = z.infer<typeof Notification>;

export const GarthMessage = z.object({
  id: z.string(),
  ts: z.number(),
  role: z.enum(["user", "garth", "system"]),
  text: z.string(),
});
export type GarthMessage = z.infer<typeof GarthMessage>;

export const GarthState = z.enum(["idle", "thinking", "speaking", "alert"]);
export type GarthState = z.infer<typeof GarthState>;

/** A G.A.R.T.H. channel: its own conversation (and Claude Code session). */
export interface ChannelView {
  id: string;
  name: string;
  state: GarthState;
  updatedAt: number;
  transcript: GarthMessage[]; // most recent messages
}

/** Full world snapshot pushed to the UI on every change. */
export interface Snapshot {
  hq: { id: string; name: string; startedAt: number };
  outposts: Outpost[];
  agents: Agent[];
  tasks: Task[];
  notifications: Notification[];
  garth: { state: GarthState; channels: ChannelView[] }; // channels: most recently active first
}

// ───────────────────── Outpost ⇄ HQ wire protocol ─────────────────────

export const Ops = {
  "fs.list": { args: z.object({ path: z.string() }) },
  "fs.read": { args: z.object({ path: z.string(), maxBytes: z.number().optional() }) },
  "fs.write": { args: z.object({ path: z.string(), content: z.string() }) },
  exec: { args: z.object({ cmd: z.string(), cwd: z.string().optional(), timeoutMs: z.number().optional() }) },
  "agent.run": {
    args: z.object({
      taskId: z.string(),
      harness: Harness,
      lane: Lane,
      instruction: z.string(),
      cwd: z.string().optional(),
    }),
  },
  "agent.send": { args: z.object({ agentId: z.string(), text: z.string() }) },
  "agent.cancel": { args: z.object({ agentId: z.string() }) },
  "cloud.list": { args: z.object({ harness: Harness }) },
} as const;
export type Op = keyof typeof Ops;
export type OpArgs<K extends Op> = z.infer<(typeof Ops)[K]["args"]>;

export const Request = z.object({
  type: z.literal("req"),
  id: z.string(),
  op: z.enum(Object.keys(Ops) as [Op, ...Op[]]),
  args: z.unknown(),
});
export type Request = z.infer<typeof Request>;

export const Response = z.object({
  type: z.literal("res"),
  id: z.string(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type Response = z.infer<typeof Response>;

export const Hello = z.object({
  type: z.literal("hello"),
  outpost: Outpost.omit({ status: true, lastSeen: true }),
});
export const Heartbeat = z.object({ type: z.literal("heartbeat"), load: z.number().optional() });
export const AgentsSync = z.object({ type: z.literal("agents"), agents: z.array(Agent) });
export const AgentEvent = z.object({
  type: z.literal("event"),
  taskId: z.string(),
  agentId: z.string(),
  event: TaskEvent,
});

export const OutpostToHq = z.discriminatedUnion("type", [Hello, Heartbeat, Response, AgentsSync, AgentEvent]);
export type OutpostToHq = z.infer<typeof OutpostToHq>;
export const HqToOutpost = z.discriminatedUnion("type", [Request]);
export type HqToOutpost = z.infer<typeof HqToOutpost>;

// ───────────────────── HQ → UI ─────────────────────

export type HqToUi =
  | { type: "snapshot"; state: Snapshot }
  | { type: "garth.delta"; channelId: string; text: string }
  | { type: "garth.activity"; channelId: string; text: string }
  | { type: "task.event"; taskId: string; event: TaskEvent };

// ───────────────────── helpers ─────────────────────

export const newId = (prefix = "") =>
  prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
