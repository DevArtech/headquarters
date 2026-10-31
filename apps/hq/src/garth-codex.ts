import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { cleanEnv } from "@hq/outpost";
import { describe, type Sink } from "./garth-cc.js";

export interface CodexOptions {
  cwd: string; // the Headquarters repo: G.A.R.T.H. can read and modify it
  systemPrompt: string;
  threadId?: string;
  onThread(id: string | undefined): void;
  model?: string;
  mcpBridge: string; // path to bin/mcp-bridge.mjs
  hqApi: string;
  hqToken: string;
  channelId?: string; // tool calls from this thread are attributed to this channel
}

interface Turn {
  sink: Sink;
  threadId: string;
  error?: string;
  resolve(): void;
  reject(e: Error): void;
}

type Json = Record<string, any>;

/**
 * G.A.R.T.H.'s brain on the Codex harness: one persistent `codex app-server` process, spoken to in
 * JSON-RPC over stdio. Each operator message is one turn on a Codex thread; the thread id is persisted
 * so the conversation survives Headquarters restarts (resumed with thread/resume). Fleet tools reach
 * it through the same MCP bridge Claude Code uses; the operator's own Codex MCP servers are left out.
 */
export class CodexBrain {
  private proc: ChildProcess | null = null;
  private ready: Promise<string[]> | null = null; // resolves to the operator's own MCP server names
  private rpc = 0;
  private pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  private current: Turn | null = null;
  private stderr = "";
  private threadId?: string;
  private loaded?: string; // thread live in the current process

  constructor(private opts: CodexOptions) {
    this.threadId = opts.threadId;
  }

  async turn(text: string, sink: Sink): Promise<void> {
    const threadId = await this.thread();
    const env = process.env;
    return new Promise((resolve, reject) => {
      this.current = { sink, threadId, resolve, reject };
      this.request("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
        effort: env.GARTH_CODEX_EFFORT ?? "medium",
        ...(this.model ? { model: this.model } : {}),
      }).catch((e) => this.fail(e));
    });
  }

  /** Start Codex and open the thread ahead of the first message so the first reply is fast. */
  warm() {
    this.thread().catch((e) => console.error("[garth] codex warm-up failed:", (e as Error).message));
  }

  stop() {
    this.proc?.kill("SIGTERM");
    this.proc = null;
  }

  private get model() {
    return this.opts.model ?? process.env.GARTH_CODEX_MODEL;
  }

  private async thread(): Promise<string> {
    const others = await this.ensure();
    if (this.loaded) return this.loaded;
    const env = process.env;
    const params = {
      cwd: this.opts.cwd,
      approvalPolicy: "never", // nobody is at a prompt to approve; the sandbox is the boundary
      sandbox: env.GARTH_CODEX_SANDBOX ?? "workspace-write",
      developerInstructions: this.opts.systemPrompt,
      ...(this.model ? { model: this.model } : {}),
      config: {
        "sandbox_workspace_write.network_access": true,
        "features.apps": false,
        "features.plugins": false,
        ...Object.fromEntries(others.filter((n) => n !== "hq").map((n) => [`mcp_servers.${n}.enabled`, false])),
        "mcp_servers.hq": {
          command: process.execPath,
          args: [this.opts.mcpBridge],
          env: { HQ_API: this.opts.hqApi, HQ_TOKEN: this.opts.hqToken, HQ_CHANNEL: this.opts.channelId ?? "" },
          default_tools_approval_mode: "approve",
          tool_timeout_sec: 600,
        },
      },
    };
    let res: Json | undefined;
    if (this.threadId) {
      // a stale/unknown thread id fails to resume; start fresh instead
      res = await this.request("thread/resume", { threadId: this.threadId, excludeTurns: true, ...params }).catch(() => undefined);
    }
    res ??= await this.request("thread/start", params);
    const id: string = res!.thread.id;
    if (id !== this.threadId) {
      this.threadId = id;
      this.opts.onThread(id);
    }
    return (this.loaded = id);
  }

  private ensure(): Promise<string[]> {
    if (this.proc && this.proc.exitCode === null && this.ready) return this.ready;
    const args = ["app-server", "-c", "notify=[]", ...(process.env.GARTH_CODEX_ARGS ?? "").split(/\s+/).filter(Boolean)];
    this.stderr = "";
    this.loaded = undefined;
    const proc = spawn(process.env.GARTH_CODEX_BIN ?? "codex", args, { cwd: this.opts.cwd, env: cleanEnv(), stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stderr!.on("data", (d) => (this.stderr = (this.stderr + d.toString()).slice(-4000)));
    readline.createInterface({ input: proc.stdout! }).on("line", (l) => this.onLine(l));
    proc.on("error", (e) => this.close(new Error(`could not start Codex: ${e.message}`)));
    proc.on("close", (code) => {
      if (this.proc === proc) this.proc = null;
      this.close(new Error(`Codex exited (${code})${this.stderr ? ": " + this.stderr.trim().split("\n").slice(-3).join(" ") : ""}`));
    });
    this.ready = (async () => {
      await this.request("initialize", { clientInfo: { name: "headquarters", title: "Headquarters", version: "0.1.0" }, capabilities: { experimentalApi: false, requestAttestation: false } });
      this.send({ method: "initialized" });
      const cfg = await this.request("config/read", {}).catch(() => ({}));
      return Object.keys(cfg?.config?.mcp_servers ?? {});
    })();
    this.ready.catch(() => {});
    return this.ready;
  }

  private send(msg: Json) {
    this.proc?.stdin?.write(JSON.stringify(msg) + "\n");
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = ++this.rpc;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  /** The process is gone: everything waiting on it fails. */
  private close(e: Error) {
    this.ready = null;
    this.loaded = undefined;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    this.fail(e);
  }

  private fail(e: Error) {
    const t = this.current;
    this.current = null;
    t?.reject(e);
  }

  private onLine(line: string) {
    let j: Json;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    if (j.id !== undefined && j.method) return this.answer(j.id, j.method);
    if (j.id !== undefined) {
      const p = this.pending.get(j.id);
      this.pending.delete(j.id);
      if (j.error) p?.reject(new Error(j.error.message ?? "Codex request failed"));
      else p?.resolve(j.result);
      return;
    }
    const t = this.current;
    const ev: Json = j.params ?? {};
    if (!t || ev.threadId !== t.threadId) return; // sub-agent threads stay out of G.A.R.T.H.'s voice

    switch (j.method) {
      case "item/agentMessage/delta":
        t.sink.delta(ev.delta);
        break;
      case "item/started": {
        const what = activity(ev.item, this.opts.cwd);
        if (what) t.sink.activity(what);
        break;
      }
      case "item/completed":
        if (ev.item?.type === "agentMessage" && ev.item.text?.trim()) t.sink.message(ev.item.text.trim());
        break;
      case "error":
        if (!ev.willRetry) t.error = ev.error?.message;
        break;
      case "turn/completed": {
        this.current = null;
        const turn = ev.turn ?? {};
        if (turn.status === "completed") t.resolve();
        else t.reject(new Error(turn.error?.message ?? t.error ?? `Codex turn ${turn.status ?? "failed"}`));
        break;
      }
    }
  }

  /** Codex asking the client something. With approvals off these should not come; refuse anything that does. */
  private answer(id: number | string, method: string) {
    if (method.endsWith("requestApproval") || method === "execCommandApproval" || method === "applyPatchApproval") this.send({ id, result: { decision: "decline" } });
    else if (method === "mcpServer/elicitation/request") this.send({ id, result: { action: "decline", content: null, _meta: null } });
    else this.send({ id, error: { code: -32601, message: `Headquarters does not handle ${method}` } });
  }
}

/** A Codex thread item as a few words, in the same style as the Claude Code brain. */
function activity(item: Json | undefined, cwd: string): string {
  switch (item?.type) {
    case "commandExecution":
      return describe("Bash", { command: item.command }, cwd);
    case "fileChange":
      return describe("Edit", { file_path: item.changes?.[0]?.path }, cwd);
    case "mcpToolCall":
      return describe(`mcp__${item.server}__${item.tool}`, item.arguments ?? {}, cwd);
    case "webSearch":
      return describe("WebSearch", { query: item.query ?? item.action?.query ?? "" }, cwd);
    case "collabAgentToolCall":
      return describe("Agent", { description: item.prompt?.split("\n")[0]?.slice(0, 70) ?? "" }, cwd);
    default:
      return "";
  }
}
