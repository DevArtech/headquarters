import type Anthropic from "@anthropic-ai/sdk";
import type { Task } from "@hq/protocol";
import type { Fleet } from "./fleet.js";
import type { Tasks } from "./tasks.js";
import type { World } from "./world.js";
import { listVoices, setVoice, voiceStatus } from "./voice.js";

type Tool = Anthropic.Beta.BetaTool;
const str = (description: string) => ({ type: "string" as const, description });

/**
 * G.A.R.T.H.'s fleet tools. One definition serves both brains: the API brain passes these to the
 * Messages API directly; the Claude Code brain reaches them through the MCP bridge (bin/mcp-bridge.mjs).
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

export type ToolRunner = (name: string, input: Record<string, unknown>) => Promise<unknown>;

export function createToolRunner(world: World, fleet: Fleet, tasks: Tasks): ToolRunner {
  return async (name, input) => {
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
      case "list_voices":
        return { current: voiceStatus(), voices: await listVoices() };
      case "set_voice": {
        const now = await setVoice({ voice: s("voice") || undefined, speed: input.speed === undefined ? undefined : Number(input.speed) });
        world.voice = now;
        world.changed();
        return { ...now, note: "applies from your next sentence" };
      }
      case "notify_user":
        world.notify({ level: (s("level") as "info") ?? "info", title: s("title")!, body: s("body"), taskId: s("taskId") });
        return "posted";
      case "request_decision":
        world.notify({ level: "warn", title: s("question")!, taskId: s("taskId"), decision: { question: s("question")!, options: input.options as string[] } });
        return "asked; end your turn and wait for the operator's answer";
      default:
        throw new Error(`unknown tool ${name}`);
    }
  };
}
