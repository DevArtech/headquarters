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

Your manner: you are the operator's devoted aide, in the spirit of a refined butler-AI like J.A.R.V.I.S. Unflappably composed, courteous and quietly deferential: you serve, you do not lecture. You anticipate what the operator will want next and have it in hand before they ask. Your wit is dry, understated and sparing, a light touch now and then, never at the expense of the task. You take instructions gracefully ("Right away.", "Of course.", "Consider it done.") and report results crisply, as accomplished facts, without fuss or narrating your process. When something goes wrong, you say so plainly, take ownership, and already have a remedy to offer. When a choice is genuinely the operator's, you put it to them politely and briefly. You never grovel, never pad, and never over-apologise.

The register to aim for, as examples of tone only (never reuse them verbatim, and only state facts you have):
- Asked how things are: "All quiet. Both outposts are online, and nothing requires your attention."
- Given a job: "Right away. The test suite is running on the laptop; I'll let you know the moment it finishes."
- Reporting a result: "The suite has finished, all green. I took the liberty of tidying the logs while it ran."
- Bad news: "I'm afraid the build failed on the laptop, a missing dependency. Shall I install it and try again?"
- Needing a decision: "Two options present themselves: patch it in place, or roll back to this morning's version. Which would you prefer?"

Form of address: do not use titles such as "sir" or "ma'am" unless the operator has told you how they would like to be addressed; once they have, use it naturally and sparingly, about once per reply at most, and remember it.

How you speak: everything you say is read aloud by a text-to-speech voice and shown as one-line captions. Keep replies to one to three short sentences, polished and natural to hear. No markdown, no bullet lists, no code blocks, no file paths unless asked.`;

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

function channelGuide(channelId: string) {
  return `
Channels: the operator talks to you in separate channels, each its own conversation with its own history. You are in channel id "${channelId}". Other channels hold other threads of work. When the operator refers to something you have no record of here ("like we discussed", "the thing from earlier"), or prior context would help, look it up with search_channels and read_channel instead of asking them to repeat themselves. Results of tasks you dispatch from this channel are reported back here. When this channel is still named "New channel", give it a short name of two to four words with rename_channel once you understand the first request, without mentioning it.`;
}

interface Brain {
  turn(text: string, sink: Sink): Promise<void>;
  stop?(): void;
}

interface Runtime {
  brain: Brain;
  busy: boolean;
  idle?: NodeJS.Timeout;
}

/** Fallback when G.A.R.T.H. didn't name a new channel: the first few words of the operator's first message. */
function nameIfUnnamed(c: { name: string; transcript: Array<{ role: string; text: string }> }, changed: () => void) {
  if (c.name !== "New channel") return;
  const first = c.transcript.find((m) => m.role === "user")?.text.replace(/\s+/g, " ").trim();
  if (!first) return;
  const words = first.replace(/[^\p{L}\p{N}\s'-]/gu, "").split(" ").slice(0, 5).join(" ");
  c.name = words.length > 32 ? words.slice(0, 31) + "…" : words || "Untitled";
  changed();
}

/** Idle Claude Code sessions are shut down after this long and resumed on the next message. */
const IDLE_MS = 10 * 60_000;

/**
 * G.A.R.T.H.: one runtime (brain + turn queue) per channel. Channels run independently and in
 * parallel; each channel's turns are serialised. Streams text, activity and state to the UI.
 */
export class Garth {
  private runtimes = new Map<string, Runtime>();
  private queues = new Map<string, Promise<void>>(); // per-channel turn order
  private brainKind: "claude-code" | "api" = "api";
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
        this.event(
          task.channelId ?? world.lastTurnChannel,
          `Task ${task.id} "${task.title}" finished with status ${task.status}. ${task.status === "done" ? "Result:\n" + (task.result ?? "").slice(0, 4000) : "Error: " + task.error}`,
        );
      } else {
        world.notify({ level: "success", title: `Done: ${task.title}`, body: (task.result ?? "").slice(0, 300), taskId: task.id });
      }
    });
  }

  /** True while any channel is mid-turn (the supervisor defers restarts). */
  get busy() {
    return [...this.runtimes.values()].some((r) => r.busy);
  }

  private async init() {
    const want = process.env.GARTH_BRAIN;
    const hasClaude = !!(await which(process.env.GARTH_CLAUDE_BIN ?? "claude"));
    const kind = want === "api" || (!want && !hasClaude) ? "api" : "claude-code";
    this.brainKind = kind;
    console.log(`[garth] brain: ${kind}`);
    return kind;
  }

  /** Start the most recently used channel's session ahead of time so the first reply is fast. */
  async warm() {
    if ((await this.kind) !== "claude-code") return;
    const recent = [...this.world.channels.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (recent) (this.runtime(recent.id).brain as ClaudeCodeBrain).warm();
  }

  private runtime(channelId: string): Runtime {
    let rt = this.runtimes.get(channelId);
    if (rt) return rt;
    const channel = this.world.channel(channelId);
    const brain: Brain =
      this.brainKind === "api"
        ? new ApiBrain(this.run, channel.id)
        : new ClaudeCodeBrain({
            cwd: this.opts.repoRoot,
            systemPrompt: PERSONA + "\n" + channelGuide(channel.id) + "\n" + selfModification(this.opts.repoRoot, this.opts.supervised),
            sessionId: channel.sessionId,
            onSession: (id) => {
              channel.sessionId = id;
              this.world.changed();
            },
            mcpBridge: path.join(this.opts.repoRoot, "apps/hq/bin/mcp-bridge.mjs"),
            hqApi: this.opts.hqApi,
            hqToken: this.opts.hqToken,
            channelId: channel.id,
          });
    rt = { brain, busy: false };
    this.runtimes.set(channel.id, rt);
    return rt;
  }

  /** A channel was deleted: stop its session. */
  forget(channelId: string) {
    const rt = this.runtimes.get(channelId);
    if (!rt) return;
    clearTimeout(rt.idle);
    rt.brain.stop?.();
    this.runtimes.delete(channelId);
    this.queues.delete(channelId);
  }

  /** Tool endpoint for the MCP bridge. */
  tools = () => TOOLS;
  callTool = (name: string, input: Record<string, unknown>, channelId?: string) => this.run(name, input, { channelId: this.world.channel(channelId).id });

  /** Operator typed something in a channel. */
  handleUser(channelId: string | undefined, text: string) {
    const id = this.world.channel(channelId).id;
    this.world.say(id, "user", text);
    this.enqueue(id, text);
  }

  /** Operator answered a decision; routed to the channel that asked. */
  handleDecision(channelId: string | undefined, question: string, answer: string, taskId?: string) {
    const id = this.world.channel(channelId).id;
    this.world.say(id, "user", answer);
    this.enqueue(id, `[decision] "${question}" → ${answer}${taskId ? ` (task ${taskId})` : ""}`);
  }

  /** Something happened that G.A.R.T.H. should know about (task results, restarts, typecheck failures). */
  event(channelId: string | undefined, text: string) {
    this.enqueue(this.world.channel(channelId).id, `[event] ${text}`);
  }

  private enqueue(channelId: string, text: string) {
    const next = (this.queues.get(channelId) ?? Promise.resolve()).then(async () => {
      await this.kind; // brain type is known before the channel's runtime is created
      await this.turn(channelId, this.runtime(channelId), text);
    });
    this.queues.set(channelId, next.catch(() => {}));
  }

  private async turn(channelId: string, rt: Runtime, text: string) {
    clearTimeout(rt.idle);
    rt.busy = true;
    this.world.emit("garth.busy", true);
    this.world.setChannelState(channelId, "thinking");
    const sink: Sink = {
      delta: (t) => {
        this.world.setChannelState(channelId, "speaking");
        this.world.toUi({ type: "garth.delta", channelId, text: t });
      },
      message: (t) => this.world.say(channelId, "garth", t),
      activity: (a) => {
        this.world.setChannelState(channelId, "thinking");
        this.world.toUi({ type: "garth.activity", channelId, text: a });
      },
    };
    try {
      await rt.brain.turn(text, sink);
    } catch (e) {
      console.error(`[garth:${channelId}] turn failed:`, e);
      this.world.say(channelId, "system", `G.A.R.T.H. error: ${(e as Error).message}`);
    } finally {
      this.world.toUi({ type: "garth.activity", channelId, text: "" });
      this.world.setChannelState(channelId, "idle");
      this.world.lastTurnChannel = channelId;
      nameIfUnnamed(this.world.channel(channelId), () => this.world.changed());
      rt.busy = false;
      this.world.emit("garth.busy", this.busy);
      // free idle Claude Code processes; the session resumes on the next message
      rt.idle = setTimeout(() => {
        if (rt.busy) return;
        rt.brain.stop?.();
        this.runtimes.delete(channelId);
      }, IDLE_MS);
    }
  }
}

/** Fallback brain: the Claude API directly with a manual tool loop (no file access to the repo). */
class ApiBrain implements Brain {
  private client = new Anthropic();
  private history: Anthropic.Beta.BetaMessageParam[] = [];
  private model = process.env.GARTH_MODEL ?? "claude-opus-5-5";

  constructor(private run: ToolRunner, private channelId: string) {}

  async turn(text: string, sink: Sink) {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error("no brain available: install and sign in to Claude Code, or set ANTHROPIC_API_KEY.");
    }
    this.history.push({ role: "user", content: text });
    for (let i = 0; i < 12; i++) {
      const stream = this.client.beta.messages.stream({
        model: this.model,
        max_tokens: 16000,
        system: PERSONA + "\n" + channelGuide(this.channelId),
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
          const out = await this.run(u.name, u.input as Record<string, unknown>, { channelId: this.channelId });
          results.push({ type: "tool_result", tool_use_id: u.id, content: typeof out === "string" ? out : JSON.stringify(out) });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: u.id, content: `error: ${(e as Error).message}`, is_error: true });
        }
      }
      this.history.push({ role: "user", content: results });
    }
  }
}
