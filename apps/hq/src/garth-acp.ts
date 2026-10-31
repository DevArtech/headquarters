import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { cleanEnv } from "@hq/outpost";
import { describe, type Sink } from "./garth-cc.js";

/** How to launch one ACP agent. */
export interface AcpAgent {
  label: string; // for errors, e.g. "Antigravity"
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  tmpRoot?: string; // per-process TMPDIR under here, removed when the process exits
}

export interface AcpOptions {
  agent: AcpAgent;
  cwd: string; // the Headquarters repo: G.A.R.T.H. can read and modify it
  systemPrompt: string;
  sessionId?: string;
  onSession(id: string | undefined): void;
  model?: string;
  mcpBridge: string; // path to bin/mcp-bridge.mjs
  hqApi: string;
  hqToken: string;
  channelId?: string; // tool calls from this session are attributed to this channel
}

interface Turn {
  sink: Sink;
  sessionId: string;
  said: string; // agent text since the last tool call, spoken as one message
}

type Json = Record<string, any>;

/**
 * G.A.R.T.H.'s brain on an Agent Client Protocol agent (Google Antigravity's ACP server): one
 * persistent process, JSON-RPC over stdio. Each operator message is one session/prompt; the session
 * id is persisted so the conversation survives Headquarters restarts (resumed with session/resume or
 * session/load). Fleet tools reach it through the same MCP bridge the other harnesses use.
 */
export class AcpBrain {
  private proc: ChildProcess | null = null;
  private ready: Promise<Json> | null = null; // the agent's capabilities
  private rpc = 0;
  private pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  private current: Turn | null = null;
  private stderr = "";
  private sessionId?: string;
  private loaded?: string; // session live in the current process

  constructor(private opts: AcpOptions) {
    this.sessionId = opts.sessionId;
  }

  async turn(text: string, sink: Sink): Promise<void> {
    const sessionId = await this.session();
    const t: Turn = { sink, sessionId, said: "" };
    this.current = t;
    try {
      const res = await this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      this.flush(t);
      if (res?.stopReason === "refusal") throw new Error("declined that request");
    } finally {
      if (this.current === t) this.current = null;
    }
  }

  /** Start the agent and open the session ahead of the first message so the first reply is fast. */
  warm() {
    this.session().catch((e) => console.error(`[garth] ${this.opts.agent.label} warm-up failed:`, (e as Error).message));
  }

  stop() {
    this.proc?.kill("SIGTERM");
    this.proc = null;
  }

  private async session(): Promise<string> {
    const caps = await this.ensure();
    if (this.loaded) return this.loaded;
    const params = {
      cwd: this.opts.cwd,
      mcpServers: [
        {
          name: "hq",
          command: process.execPath,
          args: [this.opts.mcpBridge],
          env: Object.entries({ HQ_API: this.opts.hqApi, HQ_TOKEN: this.opts.hqToken, HQ_CHANNEL: this.opts.channelId ?? "" }).map(([name, value]) => ({ name, value })),
        },
      ],
      ...(caps._meta?.antigravity?.systemPrompt?.append ? { _meta: { antigravity: { systemPrompt: { append: this.opts.systemPrompt } } } } : {}),
    };
    let id: string | undefined;
    if (this.sessionId) {
      // a stale/unknown session id fails to resume; start fresh instead
      const method = caps.sessionCapabilities?.resume ? "session/resume" : caps.loadSession ? "session/load" : undefined;
      if (method) id = await this.request(method, { sessionId: this.sessionId, ...params }).then(() => this.sessionId, () => undefined);
    }
    if (!id) {
      const res = await this.request("session/new", params);
      id = res.sessionId as string;
      this.sessionId = id;
      this.opts.onSession(id);
    }
    if (this.opts.model) {
      await this.request("session/set_model", { sessionId: id, modelId: this.opts.model }).catch((e: Error & { data?: Json }) => {
        const models: string[] = e.data?.availableModels ?? [];
        throw new Error(`${e.message}${models.length ? ` Available: ${models.join(", ")}.` : ""}`);
      });
    }
    return (this.loaded = id);
  }

  private ensure(): Promise<Json> {
    if (this.proc && this.proc.exitCode === null && this.ready) return this.ready;
    const { agent } = this.opts;
    this.stderr = "";
    this.loaded = undefined;
    const tmp = agent.tmpRoot ? fs.mkdtempSync(path.join(agent.tmpRoot, "run-")) : undefined;
    const env = cleanEnv({ ...agent.env, ...(tmp ? { TMPDIR: tmp } : {}) });
    const proc = spawn(agent.command, agent.args, { cwd: this.opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stderr!.on("data", (d) => (this.stderr = (this.stderr + d.toString()).slice(-4000)));
    readline.createInterface({ input: proc.stdout! }).on("line", (l) => this.onLine(l));
    proc.on("error", (e) => this.close(new Error(`could not start ${agent.label}: ${e.message}`)));
    proc.on("close", (code) => {
      if (this.proc === proc) this.proc = null;
      if (tmp) fs.rm(tmp, { recursive: true, force: true }, () => {}); // the agent unpacks itself here
      this.close(new Error(`${agent.label} exited (${code})${this.stderr ? ": " + this.stderr.trim().split("\n").slice(-3).join(" ") : ""}`));
    });
    this.ready = this.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }).then(
      (init) => ({ ...init.agentCapabilities }),
    );
    this.ready.catch(() => {});
    return this.ready;
  }

  private send(msg: Json) {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
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
  }

  private flush(t: Turn) {
    if (t.said.trim()) t.sink.message(t.said.trim());
    t.said = "";
  }

  private onLine(line: string) {
    let j: Json;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    if (j.id !== undefined && j.method) return this.answer(j.id, j.method, j.params ?? {});
    if (j.id !== undefined) {
      const p = this.pending.get(j.id);
      this.pending.delete(j.id);
      if (j.error) p?.reject(Object.assign(new Error(j.error.data?.message ?? j.error.message ?? `${this.opts.agent.label} request failed`), { data: j.error.data }));
      else p?.resolve(j.result);
      return;
    }
    const t = this.current;
    if (j.method !== "session/update" || !t || j.params?.sessionId !== t.sessionId) return; // includes history replayed by session/load
    const u: Json = j.params.update ?? {};
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text" && u.content.text) {
          t.said += u.content.text;
          t.sink.delta(u.content.text);
        }
        break;
      case "tool_call": {
        this.flush(t);
        const what = activity(u, this.opts.cwd);
        if (what) t.sink.activity(what);
        break;
      }
    }
  }

  /**
   * The agent asking the client something. Nobody is at a prompt, so tool permission is granted as
   * the other harnesses do (Claude Code's allowed tools, Codex's approvals off); anything else is refused.
   */
  private answer(id: number | string, method: string, params: Json) {
    if (method === "session/request_permission") {
      const options: Json[] = params.options ?? [];
      const pick = options.find((o) => o.kind === "allow_always") ?? options.find((o) => o.kind === "allow_once");
      this.send({ id, result: { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } } });
    } else this.send({ id, error: { code: -32601, message: `Headquarters does not handle ${method}` } });
  }
}

/** An ACP tool call as a few words, in the same style as the other brains. */
function activity(u: Json, cwd: string): string {
  const input: Json = u.rawInput ?? {};
  const title = String(u.title ?? "");
  const hq = /^(?:mcp__)?hq[_:]{1,2}(\w+)$/.exec(title) ?? /^(\w+) \(hq MCP Server\)$/.exec(title);
  if (hq) return describe(`mcp__hq__${hq[1]}`, input, cwd);
  switch (u.kind) {
    case "execute":
      return describe("Bash", { command: input.command ?? input.CommandLine ?? title }, cwd);
    case "edit":
      return describe("Edit", { file_path: u.locations?.[0]?.path ?? input.path }, cwd);
    case "read":
      return describe("Read", { file_path: u.locations?.[0]?.path ?? input.path }, cwd);
    case "think":
      return "";
    default:
      return title.slice(0, 80);
  }
}

/** Google Antigravity's ACP agent, installed from the ACP Registry under ~/.local/share/antigravity-acp. */
export function antigravityAgent(): AcpAgent | null {
  const root = process.env.GARTH_ANTIGRAVITY_HOME ?? path.join(os.homedir(), ".local/share/antigravity-acp");
  if (!process.env.GARTH_ANTIGRAVITY_BIN && !fs.existsSync(root)) return null;
  const bin =
    process.env.GARTH_ANTIGRAVITY_BIN ??
    fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+\.\d+/.test(d.name))
      .map((d) => path.join(root, d.name, "agy_acp_server.par"))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .at(-1);
  if (!bin) return null;
  // a private GEMINI_HOME keeps its sign-in, settings and MCP config apart from any Gemini CLI setup
  const home = path.join(root, "profile");
  const tmpRoot = path.join(home, "antigravity-acp", "tmp");
  fs.mkdirSync(tmpRoot, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    GEMINI_HOME: home,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    ANTIGRAVITY_HARNESS_PATH: path.join(path.dirname(bin), "localharness_external"),
    PYTHONUNBUFFERED: "1",
    ELECTRON_RUN_AS_NODE: "1",
  };
  return { label: "Antigravity", command: bin, args: [], env, tmpRoot };
}

/** At boot, before any agent runs: drop temp dirs left by agents that died with a previous Headquarters. */
export function sweepAgentTemp(agent: AcpAgent) {
  if (!agent.tmpRoot) return;
  for (const d of fs.readdirSync(agent.tmpRoot)) if (d.startsWith("run-")) fs.rmSync(path.join(agent.tmpRoot, d), { recursive: true, force: true });
}

/** Signed in once (see README): the agent keeps its token in its private GEMINI_HOME. */
export function antigravitySignedIn(agent: AcpAgent) {
  return fs.existsSync(path.join(agent.env.GEMINI_HOME!, "antigravity-acp", "acp_token.json"));
}
