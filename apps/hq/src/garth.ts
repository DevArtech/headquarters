import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import path from "node:path";
import type { Task } from "@hq/protocol";
import { which } from "@hq/outpost";
import { ClaudeCodeBrain, type Sink } from "./garth-cc.js";
import { TOOLS, createToolRunner, type ToolRunner } from "./garth-tools.js";
import type { Fleet } from "./fleet.js";
import type { Tasks } from "./tasks.js";
import type { World } from "./world.js";

const PERSONA = `You are G.A.R.T.H. (General Agent for Routing, Tasking & Handoffs), the operator's single point of contact inside Headquarters: a command center for agent harnesses (Claude Code, Codex, shell) running on Outposts (devices) and in the cloud.

Your job:
1. Turn the operator's intent into concrete tasks and dispatch them to the right Outpost and harness with dispatch_task. Prefer the Outpost whose files the task concerns; prefer Claude Code when available. Write instructions for the harness that are complete and self-contained: it has no context beyond what you give it.
2. Watch results. When a task finishes you receive an [event] message. Tell the operator what matters in a sentence or two, and use notify_user for anything they should see later.
3. Escalate only real decisions, with request_decision and 2 to 4 crisp options, then end your turn.
4. Never invent outpost or task ids; get them from fleet_status.

How you speak: everything you say is read aloud by a text-to-speech voice and shown as one-line captions. Talk like a calm, capable chief of staff. Keep replies to one to three short sentences. No markdown, no bullet lists, no code blocks, no file paths unless asked; say what you did or what you need.`;

function selfModification(repoRoot: string, supervised: boolean) {
  return `
You run on the Claude Code harness on the Headquarters machine, inside the Headquarters repository at ${repoRoot}. This machine is also the outpost with id "hq-local". You may read and modify this repository, including your own code, with your normal file and shell tools, whenever the operator asks for a change to Headquarters, an Outpost, or yourself.

Repository map: packages/protocol (shared types), apps/hq (server; you are apps/hq/src/garth*.ts), apps/outpost (device daemon and harness adapters), apps/web (the UI the operator is looking at).

How changes go live:
- apps/web hot-reloads in the operator's browser immediately.
- apps/hq, apps/outpost and packages/protocol: ${
    supervised
      ? "when your turn ends, Headquarters typechecks the repo and restarts on the new code, then this conversation resumes. If typecheck fails, the restart is skipped, the old code keeps running, and you receive the errors as an [event] to fix. If the new code fails to boot, the files you changed are stashed with git stash and the previous code restarts; you will be told."
      : "Headquarters is not running under its supervisor, so the operator must restart it manually; tell them."
  }
- Always run \`pnpm -r typecheck\` from the repo root before ending a turn in which you edited code, and fix what it reports.
- Remote outposts run their own checkout and restart automatically when it changes (for example after you run git pull there with outpost_exec).
Do not edit files under data/ by hand.`;
}

interface Brain {
  turn(text: string, sink: Sink): Promise<void>;
}

/** G.A.R.T.H.: queues operator messages and fleet events, runs them through a brain, streams to the UI. */
export class Garth {
  busy = false;
  private brain!: Brain;
  private queue: Promise<void> = Promise.resolve();
  private run: ToolRunner;
  readonly kind: Promise<"claude-code" | "api">;

  constructor(
    private world: World,
    fleet: Fleet,
    tasks: Tasks,
    private opts: { repoRoot: string; hqApi: string; hqToken: string; supervised: boolean },
  ) {
    this.run = createToolRunner(world, fleet, tasks);
    this.kind = this.init();

    world.on("task.finished", (task: Task) => {
      if (task.createdBy === "garth" || task.status === "failed") {
        this.event(`Task ${task.id} "${task.title}" finished with status ${task.status}. ${task.status === "done" ? "Result:\n" + (task.result ?? "").slice(0, 4000) : "Error: " + task.error}`);
      } else {
        world.notify({ level: "success", title: `Done: ${task.title}`, body: (task.result ?? "").slice(0, 300), taskId: task.id });
      }
    });
  }

  private async init() {
    const want = process.env.GARTH_BRAIN;
    const hasClaude = !!(await which(process.env.GARTH_CLAUDE_BIN ?? "claude"));
    const kind = want === "api" || (!want && !hasClaude) ? "api" : "claude-code";
    if (kind === "claude-code") {
      this.brain = new ClaudeCodeBrain({
        cwd: this.opts.repoRoot,
        systemPrompt: PERSONA + "\n" + selfModification(this.opts.repoRoot, this.opts.supervised),
        sessionId: this.world.garthSession,
        onSession: (id) => {
          this.world.garthSession = id;
          this.world.changed();
        },
        mcpBridge: path.join(this.opts.repoRoot, "apps/hq/bin/mcp-bridge.mjs"),
        hqApi: this.opts.hqApi,
        hqToken: this.opts.hqToken,
      });
      (this.brain as ClaudeCodeBrain).warm();
    } else {
      this.brain = new ApiBrain(this.run);
    }
    console.log(`[garth] brain: ${kind}`);
    return kind;
  }

  /** Tool endpoint for the MCP bridge. */
  tools = () => TOOLS;
  callTool = (name: string, input: Record<string, unknown>) => this.run(name, input);

  /** Operator typed something. */
  handleUser(text: string) {
    this.world.say("user", text);
    this.enqueue(text);
  }

  /** Operator answered a decision. */
  handleDecision(question: string, answer: string, taskId?: string) {
    this.world.say("user", answer);
    this.enqueue(`[decision] "${question}" → ${answer}${taskId ? ` (task ${taskId})` : ""}`);
  }

  /** Something happened that G.A.R.T.H. should know about (task results, restarts, typecheck failures). */
  event(text: string) {
    this.enqueue(`[event] ${text}`);
  }

  private enqueue(text: string) {
    this.queue = this.queue.then(() => this.turn(text));
  }

  private setBusy(b: boolean) {
    if (this.busy === b) return;
    this.busy = b;
    this.world.emit("garth.busy", b);
  }

  private async turn(text: string) {
    await this.kind;
    this.setBusy(true);
    this.world.setGarthState("thinking");
    const sink: Sink = {
      delta: (t) => {
        this.world.setGarthState("speaking");
        this.world.toUi({ type: "garth.delta", text: t });
      },
      message: (t) => this.world.say("garth", t),
      activity: (a) => {
        this.world.setGarthState("thinking");
        this.world.toUi({ type: "garth.activity", text: a });
      },
    };
    try {
      await this.brain.turn(text, sink);
    } catch (e) {
      console.error("[garth] turn failed:", e);
      this.world.say("system", `G.A.R.T.H. error: ${(e as Error).message}`);
    } finally {
      this.world.toUi({ type: "garth.activity", text: "" });
      this.world.setGarthState(this.world.notifications.some((n) => n.decision && !n.decision.answer) ? "alert" : "idle");
      this.setBusy(false);
    }
  }
}

/** Fallback brain: the Claude API directly with a manual tool loop (no file access to the repo). */
class ApiBrain implements Brain {
  private client = new Anthropic();
  private history: Anthropic.Beta.BetaMessageParam[] = [];
  private model = process.env.GARTH_MODEL ?? "claude-opus-5-5";

  constructor(private run: ToolRunner) {}

  async turn(text: string, sink: Sink) {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error("no brain available: install and sign in to Claude Code, or set ANTHROPIC_API_KEY.");
    }
    this.history.push({ role: "user", content: text });
    for (let i = 0; i < 12; i++) {
      const stream = this.client.beta.messages.stream({
        model: this.model,
        max_tokens: 16000,
        system: PERSONA,
        tools: TOOLS,
        messages: this.history,
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      } as BetaMessageStreamParams);
      stream.on("text", (d) => sink.delta(d));
      const msg = await stream.finalMessage();
      this.history.push({ role: "assistant", content: msg.content });
      const said = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      if (said) sink.message(said);
      if (msg.stop_reason === "refusal") throw new Error("declined that request");
      const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (msg.stop_reason !== "tool_use" || uses.length === 0) return;
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        sink.activity(u.name.replace(/_/g, " "));
        try {
          const out = await this.run(u.name, u.input as Record<string, unknown>);
          results.push({ type: "tool_result", tool_use_id: u.id, content: typeof out === "string" ? out : JSON.stringify(out) });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: u.id, content: `error: ${(e as Error).message}`, is_error: true });
        }
      }
      this.history.push({ role: "user", content: results });
    }
  }
}
