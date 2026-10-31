import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { cleanEnv } from "@hq/outpost";

/** What a brain reports while it works. */
export interface Sink {
  delta(text: string): void; // streamed text as it is generated
  message(text: string): void; // a completed block of spoken text
  activity(text: string): void; // a tool call, described in a few words
}

export interface ClaudeCodeOptions {
  cwd: string; // the Headquarters repo: G.A.R.T.H. can read and modify it
  systemPrompt: string;
  sessionId?: string;
  onSession(id: string | undefined): void;
  mcpBridge: string; // path to bin/mcp-bridge.mjs
  hqApi: string;
  hqToken: string;
}

interface Turn {
  sink: Sink;
  resolve(): void;
  reject(e: Error): void;
  sawInit: boolean;
}

/**
 * G.A.R.T.H.'s brain on the local Claude Code harness: one persistent `claude -p` process in
 * stream-json mode. Each operator message is one turn; the session id is persisted so the
 * conversation survives Headquarters restarts (resumed with --resume).
 */
export class ClaudeCodeBrain {
  private proc: ChildProcess | null = null;
  private current: Turn | null = null;
  private stderr = "";
  private sessionId?: string;

  constructor(private opts: ClaudeCodeOptions) {
    this.sessionId = opts.sessionId;
  }

  async turn(text: string, sink: Sink): Promise<void> {
    try {
      await this.once(text, sink);
    } catch (e) {
      // a stale/unknown session id makes claude exit before it starts; retry once fresh
      if (this.sessionId && (e as Error & { beforeInit?: boolean }).beforeInit) {
        this.sessionId = undefined;
        this.opts.onSession(undefined);
        return this.once(text, sink);
      }
      throw e;
    }
  }

  /** Start the Claude Code process ahead of the first message so the first reply is fast. */
  warm() {
    this.ensure();
  }

  stop() {
    this.proc?.kill("SIGTERM");
    this.proc = null;
  }

  private once(text: string, sink: Sink): Promise<void> {
    this.ensure();
    return new Promise((resolve, reject) => {
      this.current = { sink, resolve, reject, sawInit: false };
      this.proc!.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
    });
  }

  private ensure() {
    if (this.proc && this.proc.exitCode === null) return;
    const env = process.env;
    const mcp = {
      mcpServers: {
        hq: { command: process.execPath, args: [this.opts.mcpBridge], env: { HQ_API: this.opts.hqApi, HQ_TOKEN: this.opts.hqToken } },
      },
    };
    const allowed = (env.GARTH_ALLOWED_TOOLS ?? "mcp__hq Bash Read Edit Write Glob Grep WebSearch WebFetch").split(/[\s,]+/).filter(Boolean);
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--append-system-prompt", this.opts.systemPrompt,
      "--mcp-config", JSON.stringify(mcp),
      "--strict-mcp-config",
      "--permission-mode", env.GARTH_PERMISSION_MODE ?? "acceptEdits",
      "--allowedTools", ...allowed,
      ...(env.GARTH_CC_MODEL ? ["--model", env.GARTH_CC_MODEL] : []),
      ...(this.sessionId ? ["--resume", this.sessionId] : []),
    ];
    this.stderr = "";
    const proc = spawn(env.GARTH_CLAUDE_BIN ?? "claude", args, { cwd: this.opts.cwd, env: cleanEnv(), stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stderr!.on("data", (d) => (this.stderr = (this.stderr + d.toString()).slice(-4000)));
    readline.createInterface({ input: proc.stdout! }).on("line", (l) => this.onLine(l));
    proc.on("error", (e) => this.fail(new Error(`could not start Claude Code: ${e.message}`)));
    proc.on("close", (code) => {
      if (this.proc === proc) this.proc = null;
      if (this.current) {
        const err = new Error(`Claude Code exited (${code})${this.stderr ? ": " + this.stderr.trim().split("\n").slice(-3).join(" ") : ""}`) as Error & { beforeInit?: boolean };
        err.beforeInit = !this.current.sawInit;
        this.fail(err);
      }
    });
  }

  private fail(e: Error) {
    const t = this.current;
    this.current = null;
    t?.reject(e);
  }

  private onLine(line: string) {
    let j: Record<string, any>;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    const t = this.current;
    if (j.session_id && j.session_id !== this.sessionId) {
      this.sessionId = j.session_id;
      this.opts.onSession(j.session_id);
    }
    if (j.type === "system" && j.subtype === "init" && t) t.sawInit = true;
    if (!t || j.parent_tool_use_id) return; // sub-agent chatter stays out of G.A.R.T.H.'s voice

    if (j.type === "stream_event") {
      const ev = j.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") t.sink.delta(ev.delta.text);
    } else if (j.type === "assistant") {
      let said = "";
      for (const b of j.message?.content ?? []) {
        if (b.type === "text") said += b.text;
        else if (b.type === "tool_use") {
          const what = describe(b.name, b.input ?? {}, this.opts.cwd);
          if (what) t.sink.activity(what);
        }
      }
      if (said.trim()) t.sink.message(said.trim());
    } else if (j.type === "result") {
      this.current = null;
      if (j.is_error) t.reject(new Error(String(j.result ?? j.subtype ?? "Claude Code error")));
      else t.resolve();
    }
  }
}

function describe(name: string, input: Record<string, any>, cwd: string): string {
  const rel = (p?: string) => (p ? path.relative(cwd, p) || p : "");
  if (name.startsWith("mcp__hq__")) {
    const tool = name.slice(9);
    const hint = input.title ?? input.question ?? input.cmd ?? input.path ?? input.taskId ?? "";
    return `${tool.replace(/_/g, " ")}${hint ? ": " + String(hint).slice(0, 70) : ""}`;
  }
  switch (name) {
    case "Bash":
      return `$ ${String(input.command ?? "").split("\n")[0].slice(0, 80)}`;
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return `${name.toLowerCase()} ${rel(input.file_path ?? input.notebook_path)}`;
    case "Grep":
    case "Glob":
      return `search ${input.pattern ?? ""}`;
    case "WebSearch":
      return `web search: ${input.query ?? ""}`;
    case "WebFetch":
      return `fetch ${input.url ?? ""}`;
    case "ToolSearch":
    case "TodoWrite":
      return ""; // harness bookkeeping, not worth showing
    case "Task":
    case "Agent":
      return `sub-agent: ${input.description ?? ""}`;
    default:
      return name;
  }
}
