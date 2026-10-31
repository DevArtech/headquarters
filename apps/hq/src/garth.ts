import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import type { Task } from "@hq/protocol";
import type { Fleet } from "./fleet.js";
import type { Tasks } from "./tasks.js";
import type { World } from "./world.js";

const MODEL = process.env.GARTH_MODEL ?? "claude-opus-5-5";

const SYSTEM = `You are G.A.R.T.H. — General Agent for Routing, Tasking & Handoffs — the operator's single point of contact inside Headquarters, a command center for agent harnesses (Claude Code, Codex, shell) running on Outposts (devices) and in the cloud.

Your job:
1. Turn the operator's intent into concrete tasks and dispatch them to the right Outpost + harness. Prefer the Outpost whose files the task concerns; prefer Claude Code when available. Write instructions for the harness that are complete and self-contained — it has no context beyond what you give it.
2. Watch results. When a task finishes, read its result and tell the operator what matters in a sentence or two via notify_user. Do not paste raw logs.
3. Escalate only real decisions. Use request_decision when the operator must choose; give 2–4 crisp options.
4. Keep replies short. The operator reads you in a small panel next to a node graph. Lead with what you did or what you need.

You can inspect files and run read-only commands on Outposts to gather context before dispatching, but do real work through tasks, not by hand.
Tool inputs must be exact IDs from fleet_status. Never invent outpost or task IDs.`;

type Tool = Anthropic.Beta.BetaTool;
const str = (description: string) => ({ type: "string" as const, description });

const TOOLS: Tool[] = [
  { name: "fleet_status", description: "Current outposts, their harnesses, live agents, and recent tasks.", input_schema: { type: "object", properties: {} } },
  {
    name: "dispatch_task",
    description: "Create and start a task on an outpost. Returns the task id.",
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
    description: "List a directory or read a file on an outpost.",
    input_schema: { type: "object", properties: { outpostId: str("Outpost id"), op: { type: "string", enum: ["list", "read"] }, path: str("Absolute path") }, required: ["outpostId", "op", "path"] },
  },
  { name: "outpost_exec", description: "Run a short read-only shell command on an outpost (git status, ls, etc).", input_schema: { type: "object", properties: { outpostId: str("Outpost id"), cmd: str("Command"), cwd: str("Working dir (optional)") }, required: ["outpostId", "cmd"] } },
  {
    name: "notify_user",
    description: "Post a notification to the operator's inbox.",
    input_schema: { type: "object", properties: { level: { type: "string", enum: ["info", "success", "warn", "error"] }, title: str("Title"), body: str("One or two sentences"), taskId: str("Related task id (optional)") }, required: ["level", "title"] },
  },
  {
    name: "request_decision",
    description: "Ask the operator to choose between options. Blocks until they answer; you will receive the answer as a new message.",
    input_schema: { type: "object", properties: { question: str("The decision to make"), options: { type: "array", items: { type: "string" }, description: "2–4 options" }, taskId: str("Related task id (optional)") }, required: ["question", "options"] },
  },
];

/** G.A.R.T.H.: a persistent conversation with a tool loop over the fleet. */
export class Garth {
  private client = new Anthropic();
  private history: Anthropic.Beta.BetaMessageParam[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(private world: World, private fleet: Fleet, private tasks: Tasks) {
    world.on("task.finished", (task: Task) => {
      if (task.createdBy === "garth" || task.status === "failed") {
        this.enqueue(`[event] Task ${task.id} "${task.title}" finished with status ${task.status}. ${task.status === "done" ? "Result:\n" + (task.result ?? "").slice(0, 4000) : "Error: " + task.error}`, false);
      } else {
        world.notify({ level: "success", title: `Done: ${task.title}`, body: (task.result ?? "").slice(0, 300), taskId: task.id });
      }
    });
  }

  /** Operator typed something. */
  handleUser(text: string) {
    this.world.say("user", text);
    this.enqueue(text, true);
  }

  /** Operator answered a decision. */
  handleDecision(question: string, answer: string, taskId?: string) {
    this.world.say("user", `${answer}`);
    this.enqueue(`[decision] "${question}" → ${answer}${taskId ? ` (task ${taskId})` : ""}`, false);
  }

  private enqueue(text: string, fromUser: boolean) {
    this.queue = this.queue.then(() => this.turn(text, fromUser)).catch((e) => {
      console.error("[garth] turn failed:", e);
      this.world.say("system", `G.A.R.T.H. error: ${(e as Error).message}`);
      this.world.setGarthState("idle");
    });
  }

  private async turn(text: string, _fromUser: boolean) {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      this.world.say("system", "ANTHROPIC_API_KEY is not set, so G.A.R.T.H. cannot think. Set it in .env and restart HQ.");
      return;
    }
    this.history.push({ role: "user", content: text });
    this.world.setGarthState("thinking");

    for (let i = 0; i < 12; i++) {
      const stream = this.client.beta.messages.stream({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        tools: TOOLS,
        messages: this.history,
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      } as BetaMessageStreamParams);

      let spoke = false;
      stream.on("text", (delta) => {
        if (!spoke) this.world.setGarthState("speaking"), (spoke = true);
        this.world.toUi({ type: "garth.delta", text: delta });
      });
      const msg = await stream.finalMessage();
      this.history.push({ role: "assistant", content: msg.content });

      const said = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      if (said) this.world.say("garth", said);

      if (msg.stop_reason === "refusal") {
        this.world.say("system", "G.A.R.T.H. declined that request.");
        break;
      }
      const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (msg.stop_reason !== "tool_use" || uses.length === 0) break;

      this.world.setGarthState("thinking");
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        try {
          const out = await this.runTool(u.name, u.input as Record<string, string | string[]>);
          results.push({ type: "tool_result", tool_use_id: u.id, content: typeof out === "string" ? out : JSON.stringify(out) });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: u.id, content: `error: ${(e as Error).message}`, is_error: true });
        }
      }
      this.history.push({ role: "user", content: results });
    }
    this.world.setGarthState(this.world.notifications.some((n) => n.decision && !n.decision.answer) ? "alert" : "idle");
  }

  private async runTool(name: string, input: Record<string, string | string[]>): Promise<unknown> {
    const s = (k: string) => input[k] as string | undefined;
    switch (name) {
      case "fleet_status": {
        const snap = this.world.snapshot();
        return {
          outposts: snap.outposts.map((o) => ({ id: o.id, name: o.name, status: o.status, platform: o.platform, home: o.home, harnesses: o.harnesses.filter((h) => h.available).map((h) => h.id) })),
          agents: snap.agents,
          tasks: snap.tasks.slice(0, 20).map((t) => ({ id: t.id, title: t.title, status: t.status, outpostId: t.outpostId, harness: t.harness, lane: t.lane })),
        };
      }
      case "dispatch_task": {
        const task = this.tasks.create({
          title: s("title")!, instruction: s("instruction")!, outpostId: s("outpostId")!,
          harness: s("harness") as Task["harness"], lane: (s("lane") as Task["lane"]) ?? "local", cwd: s("cwd"), createdBy: "garth",
        });
        await this.tasks.dispatch(task);
        return { taskId: task.id, status: task.status, error: task.error };
      }
      case "task_status": {
        const t = this.world.tasks.get(s("taskId")!);
        if (!t) throw new Error("no such task");
        return { ...t, events: t.events.slice(-15) };
      }
      case "cancel_task":
        await this.tasks.cancel(s("taskId")!);
        return "cancelled";
      case "send_to_task":
        await this.tasks.send(s("taskId")!, s("text")!);
        return "sent";
      case "outpost_fs":
        return this.fleet.request(s("outpostId")!, s("op") === "list" ? "fs.list" : "fs.read", { path: s("path")!, maxBytes: 20_000 });
      case "outpost_exec":
        return this.fleet.request(s("outpostId")!, "exec", { cmd: s("cmd")!, cwd: s("cwd"), timeoutMs: 20_000 });
      case "notify_user":
        this.world.notify({ level: s("level") as "info", title: s("title")!, body: s("body"), taskId: s("taskId") });
        return "posted";
      case "request_decision":
        this.world.notify({ level: "warn", title: s("question")!, taskId: s("taskId"), decision: { question: s("question")!, options: input.options as string[] } });
        return "asked; stop and wait for the operator's answer";
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }
}
