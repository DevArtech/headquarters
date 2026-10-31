import type Anthropic from "@anthropic-ai/sdk";
import type { GarthBrainKind, Task } from "@hq/protocol";
import type { Fleet } from "./fleet.js";
import type { Tasks } from "./tasks.js";
import type { World } from "./world.js";
import { listVoices, setVoice, voiceStatus } from "./voice.js";

type Tool = Anthropic.Beta.BetaTool;
const str = (description: string) => ({ type: "string" as const, description });

/**
 * G.A.R.T.H.'s fleet tools. One definition serves every brain: the API brain passes these to the
 * Messages API directly; the Claude Code and Codex brains reach them through the MCP bridge (bin/mcp-bridge.mjs).
 */
export const TOOLS: Tool[] = [
  { name: "fleet_status", description: "Current outposts, their harnesses, live agents, and recent tasks.", input_schema: { type: "object", properties: {} } },
  {
    name: "dispatch_task",
    description: "Create and start a task on an outpost's agent harness. Returns the task id. The harness has no context beyond the instruction.",
    input_schema: {
      type: "object",
      properties: {
        title: str("Short human title (≤60 chars)"),
        instruction: str("Complete, self-contained instruction for the harness"),
        outpostId: str("Outpost id from fleet_status"),
        harness: { type: "string", enum: ["claude", "codex", "shell"] },
        lane: { type: "string", enum: ["local", "cloud"], description: "Default local" },
        cwd: str("Working directory on the outpost (optional)"),
      },
      required: ["title", "instruction", "outpostId", "harness"],
    },
  },
  { name: "task_status", description: "Get a task's status, last events and result.", input_schema: { type: "object", properties: { taskId: str("Task id") }, required: ["taskId"] } },
  { name: "cancel_task", description: "Cancel a running task.", input_schema: { type: "object", properties: { taskId: str("Task id") }, required: ["taskId"] } },
  { name: "send_to_task", description: "Send a follow-up message to a task's agent (e.g. an answer it was waiting for).", input_schema: { type: "object", properties: { taskId: str("Task id"), text: str("Message") }, required: ["taskId", "text"] } },
  {
    name: "outpost_fs",
    description: "List a directory, read a file, or write a file on any outpost (including remote devices).",
    input_schema: {
      type: "object",
      properties: { outpostId: str("Outpost id"), op: { type: "string", enum: ["list", "read", "write"] }, path: str("Absolute path (~ allowed)"), content: str("File content for write") },
      required: ["outpostId", "op", "path"],
    },
  },
  {
    name: "outpost_exec",
    description: "Run a shell command on any outpost (e.g. git pull to update a remote outpost's checkout, which restarts it on the new code).",
    input_schema: { type: "object", properties: { outpostId: str("Outpost id"), cmd: str("Command"), cwd: str("Working dir (optional)") }, required: ["outpostId", "cmd"] },
  },
  {
    name: "list_channels",
    description: "List the operator's channels (separate conversations with you): id, name, last activity, message count. Marks the one you are in.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_channels",
    description:
      "Search the full history of all channels (including this one) for messages matching a query, e.g. to recall what was discussed or decided elsewhere. Returns the best matches with their channel, time and nearby context.",
    input_schema: {
      type: "object",
      properties: { query: str("Words to look for"), channelId: str("Limit to one channel (optional)"), limit: { type: "number", description: "Max matches (default 12)" } },
      required: ["query"],
    },
  },
  {
    name: "read_channel",
    description: "Read recent messages from a channel (yours or another), oldest first.",
    input_schema: {
      type: "object",
      properties: { channelId: str("Channel id from list_channels or search_channels"), limit: { type: "number", description: "How many recent messages (default 30, max 200)" } },
      required: ["channelId"],
    },
  },
  {
    name: "rename_channel",
    description: "Rename the current channel (or another one) to a short name of two to four words.",
    input_schema: { type: "object", properties: { name: str("New name"), channelId: str("Channel to rename (default: this one)") }, required: ["name"] },
  },
  {
    name: "set_brain",
    description:
      "Switch the agent harness you think with in this channel, when the operator asks (e.g. \"use Codex\", \"switch back to Claude\", \"try a different model\"). Brains: claude-code (Claude Code), codex (OpenAI Codex), api (Claude API, no repo access). Your reply now still comes from the current harness; the new one takes over from the operator's next message with a recap of this conversation, and is remembered for this channel and as the default for new ones. Say briefly that you've switched.",
    input_schema: {
      type: "object",
      properties: {
        brain: { type: "string", enum: ["claude-code", "codex", "api"], description: "Harness to switch to" },
        model: str("Model id for that harness (optional; omit for its default)"),
      },
      required: ["brain"],
    },
  },
  {
    name: "list_voices",
    description: "List the voices you can speak with (accent, gender, quality grade, best first) and the one currently in use.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_voice",
    description:
      "Change your speaking voice and/or speed, live, when the operator asks. Takes effect from your next sentence and is remembered across restarts. Voice ids look like am_michael (American male), bm_george (British male), af_heart (American female), bf_emma (British female); use list_voices if unsure.",
    input_schema: {
      type: "object",
      properties: { voice: str("Voice id, e.g. bm_george"), speed: { type: "number", description: "Speaking rate, 0.5 to 2 (1 is normal; currently ~1.05)" } },
    },
  },
  {
    name: "notify_user",
    description: "Post a notification to the operator's inbox.",
    input_schema: { type: "object", properties: { level: { type: "string", enum: ["info", "success", "warn", "error"] }, title: str("Title"), body: str("One or two sentences"), taskId: str("Related task id (optional)") }, required: ["level", "title"] },
  },
  {
    name: "request_decision",
    description: "Ask the operator to choose between options. Their answer arrives later as a new message; end your turn after asking.",
    input_schema: { type: "object", properties: { question: str("The decision to make"), options: { type: "array", items: { type: "string" }, description: "2–4 options" }, taskId: str("Related task id (optional)") }, required: ["question", "options"] },
  },
];

export type ToolContext = { channelId: string };
export type ToolRunner = (name: string, input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

const iso = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ");
const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + "…" : t);

export interface BrainControl {
  setBrain(channelId: string, kind: GarthBrainKind, model?: string): Promise<unknown>;
}

export function createToolRunner(world: World, fleet: Fleet, tasks: Tasks, brains: BrainControl): ToolRunner {
  return async (name, input, ctx) => {
    const s = (k: string) => input[k] as string | undefined;
    switch (name) {
      case "fleet_status": {
        const snap = world.snapshot();
        return {
          outposts: snap.outposts.map((o) => ({ id: o.id, name: o.name, status: o.status, platform: o.platform, home: o.home, embeddedInHq: o.embedded, harnesses: o.harnesses.filter((h) => h.available).map((h) => h.id) })),
          agents: snap.agents,
          tasks: snap.tasks.slice(0, 20).map((t) => ({ id: t.id, title: t.title, status: t.status, outpostId: t.outpostId, harness: t.harness, lane: t.lane })),
        };
      }
      case "dispatch_task": {
        const task = tasks.create({
          title: s("title")!, instruction: s("instruction")!, outpostId: s("outpostId")!,
          harness: s("harness") as Task["harness"], lane: (s("lane") as Task["lane"]) ?? "local", cwd: s("cwd"), createdBy: "garth",
          channelId: ctx.channelId,
        });
        await tasks.dispatch(task);
        return { taskId: task.id, status: task.status, error: task.error };
      }
      case "task_status": {
        const t = world.tasks.get(s("taskId")!);
        if (!t) throw new Error("no such task");
        return { ...t, events: t.events.slice(-15) };
      }
      case "cancel_task":
        await tasks.cancel(s("taskId")!);
        return "cancelled";
      case "send_to_task":
        await tasks.send(s("taskId")!, s("text")!);
        return "sent";
      case "outpost_fs": {
        const op = s("op");
        if (op === "write") return fleet.request(s("outpostId")!, "fs.write", { path: s("path")!, content: s("content") ?? "" });
        return fleet.request(s("outpostId")!, op === "list" ? "fs.list" : "fs.read", { path: s("path")!, maxBytes: 40_000 });
      }
      case "outpost_exec":
        return fleet.request(s("outpostId")!, "exec", { cmd: s("cmd")!, cwd: s("cwd"), timeoutMs: 120_000 }, 125_000);
      case "list_channels":
        return [...world.channels.values()]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((c) => ({ id: c.id, name: c.name, lastActive: iso(c.updatedAt), messages: c.transcript.length, current: c.id === ctx.channelId || undefined }));
      case "search_channels": {
        const terms = String(input.query ?? "").toLowerCase().split(/\s+/).filter((t) => t.length > 1);
        if (!terms.length) throw new Error("query is empty");
        const phrase = String(input.query).toLowerCase().trim();
        const limit = Math.min(50, Number(input.limit) || 12);
        const hits: Array<{ score: number; ts: number; out: object }> = [];
        for (const c of world.channels.values()) {
          if (s("channelId") && c.id !== s("channelId")) continue;
          c.transcript.forEach((m, i) => {
            if (m.role === "system") return;
            const text = m.text.toLowerCase();
            const matched = terms.filter((t) => text.includes(t)).length;
            if (!matched) return;
            const score = matched / terms.length + (text.includes(phrase) ? 1 : 0);
            const before = c.transcript[i - 1];
            hits.push({
              score,
              ts: m.ts,
              out: {
                channelId: c.id, channel: c.name, current: c.id === ctx.channelId || undefined, at: iso(m.ts), role: m.role === "garth" ? "you" : "operator",
                text: clip(m.text, 600),
                ...(before && before.role !== "system" ? { previous: `${before.role === "garth" ? "you" : "operator"}: ${clip(before.text, 200)}` } : {}),
              },
            });
          });
        }
        hits.sort((a, b) => b.score - a.score || b.ts - a.ts);
        return hits.length ? hits.slice(0, limit).map((h) => h.out) : "no matches";
      }
      case "read_channel": {
        const c = world.channels.get(s("channelId") ?? "");
        if (!c) throw new Error("no such channel; use list_channels");
        const n = Math.min(200, Number(input.limit) || 30);
        return {
          channel: c.name,
          messages: c.transcript.slice(-n).map((m) => ({ at: iso(m.ts), role: m.role === "garth" ? "you" : m.role === "user" ? "operator" : "system", text: clip(m.text, 1500) })),
        };
      }
      case "rename_channel": {
        const c = world.channel(s("channelId") ?? ctx.channelId);
        const name = String(input.name ?? "").trim().slice(0, 40);
        if (!name) throw new Error("name is empty");
        c.name = name;
        world.changed();
        return `renamed to "${name}"`;
      }
      case "set_brain": {
        const now = await brains.setBrain(ctx.channelId, s("brain") as GarthBrainKind, s("model") || undefined);
        return { ...(now as object), available: world.brains, note: "takes over from the operator's next message" };
      }
      case "list_voices":
        return { current: voiceStatus(), voices: await listVoices() };
      case "set_voice": {
        const now = await setVoice({ voice: s("voice") || undefined, speed: input.speed === undefined ? undefined : Number(input.speed) });
        world.voice = now;
        world.changed();
        return { ...now, note: "applies from your next sentence" };
      }
      case "notify_user":
        world.notify({ level: (s("level") as "info") ?? "info", title: s("title")!, body: s("body"), taskId: s("taskId"), channelId: ctx.channelId });
        return "posted";
      case "request_decision":
        world.notify({ level: "warn", title: s("question")!, taskId: s("taskId"), channelId: ctx.channelId, decision: { question: s("question")!, options: input.options as string[] } });
        return "asked; end your turn and wait for the operator's answer";
      default:
        throw new Error(`unknown tool ${name}`);
    }
  };
}
