import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Agent, Op, OpArgs, TaskEvent } from "@hq/protocol";
import { newId } from "@hq/protocol";
import { adapters, type RunHandle } from "./harness/index.js";

export interface OpsCtx {
  outpostId: string;
  emitEvent(taskId: string, agentId: string, event: TaskEvent): void;
  agentsChanged(agents: Agent[]): void;
}

interface Live { agent: Agent; handle: RunHandle }

/** Everything an Outpost can be asked to do, keyed by op. */
export class Ops {
  private live = new Map<string, Live>();

  constructor(private ctx: OpsCtx) {}

  agents(): Agent[] {
    return [...this.live.values()].map((l) => l.agent);
  }

  async handle<K extends Op>(op: K, args: OpArgs<K>): Promise<unknown> {
    switch (op) {
      case "fs.list": {
        const { path: p } = args as OpArgs<"fs.list">;
        const dir = expand(p);
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries
          .filter((e) => !e.name.startsWith(".") || e.name === ".env.example")
          .map((e) => ({ name: e.name, dir: e.isDirectory() }))
          .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      }
      case "fs.read": {
        const { path: p, maxBytes = 200_000 } = args as OpArgs<"fs.read">;
        const buf = await fs.readFile(expand(p));
        return { content: buf.subarray(0, maxBytes).toString("utf8"), truncated: buf.length > maxBytes, size: buf.length };
      }
      case "fs.write": {
        const { path: p, content } = args as OpArgs<"fs.write">;
        await fs.mkdir(path.dirname(expand(p)), { recursive: true });
        await fs.writeFile(expand(p), content);
        return { bytes: Buffer.byteLength(content) };
      }
      case "exec": {
        const { cmd, cwd, timeoutMs = 30_000 } = args as OpArgs<"exec">;
        return new Promise((resolve) =>
          execFile("/bin/sh", ["-c", cmd], { cwd: cwd ? expand(cwd) : os.homedir(), timeout: timeoutMs, maxBuffer: 2_000_000 }, (err, stdout, stderr) =>
            resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0, stdout: stdout.slice(-20_000), stderr: stderr.slice(-5_000) }),
          ),
        );
      }
      case "agent.run": {
        const a = args as OpArgs<"agent.run">;
        const adapter = adapters[a.harness];
        const agentId = newId("a_");
        const emit = this.emitter(a.taskId, agentId);
        const opts = { agentId, taskId: a.taskId, instruction: a.instruction, cwd: a.cwd ? expand(a.cwd) : undefined };
        let handle: RunHandle;
        if (a.lane === "cloud") {
          if (!adapter.runCloud) throw new Error(`${a.harness} has no cloud lane on this outpost yet`);
          handle = adapter.runCloud(opts, emit);
        } else {
          handle = adapter.run(opts, emit);
        }
        this.track(agentId, a.taskId, a.harness, a.lane, handle);
        return { agentId };
      }
      case "agent.send": {
        const { agentId, text } = args as OpArgs<"agent.send">;
        const l = this.live.get(agentId);
        if (!l) throw new Error(`no agent ${agentId} on this outpost`);
        const sid = l.handle.sessionId;
        if (!sid && l.agent.harness !== "shell") throw new Error("agent has no session id to resume");
        const emit = this.emitter(l.agent.taskId!, agentId);
        const handle = adapters[l.agent.harness].send(sid ?? "", text, { agentId, taskId: l.agent.taskId! }, emit);
        this.track(agentId, l.agent.taskId!, l.agent.harness, l.agent.lane, handle, l.agent.startedAt);
        return { ok: true };
      }
      case "agent.cancel": {
        const { agentId } = args as OpArgs<"agent.cancel">;
        this.live.get(agentId)?.handle.cancel();
        return { ok: true };
      }
      case "cloud.list": {
        const { harness } = args as OpArgs<"cloud.list">;
        return (await adapters[harness].listCloud?.()) ?? [];
      }
      default:
        throw new Error(`unsupported op ${op}`);
    }
  }

  private emitter(taskId: string, agentId: string) {
    return (e: Omit<TaskEvent, "ts"> & { ts?: number }) => {
      const l = this.live.get(agentId);
      if (l) {
        l.agent.updatedAt = Date.now();
        if (e.type === "status") l.agent.status = e.payload === "waiting" ? "waiting" : "running";
        if (e.type === "session" && typeof e.payload === "object" && e.payload) l.agent.sessionId = (e.payload as { sessionId?: string }).sessionId;
        if (e.type === "result") l.agent.status = "done";
        if (e.type === "error") l.agent.status = "failed";
        this.ctx.agentsChanged(this.agents());
      }
      this.ctx.emitEvent(taskId, agentId, { ts: e.ts ?? Date.now(), type: e.type, payload: e.payload });
    };
  }

  private track(agentId: string, taskId: string, harness: Agent["harness"], lane: Agent["lane"], handle: RunHandle, startedAt = Date.now()) {
    const prev = this.live.get(agentId);
    const agent: Agent = prev?.agent ?? { id: agentId, outpostId: this.ctx.outpostId, taskId, harness, lane, status: "starting", startedAt, updatedAt: Date.now() };
    agent.status = "starting";
    this.live.set(agentId, { agent, handle });
    this.ctx.agentsChanged(this.agents());
    handle.done.then(() => {
      // keep finished agents visible briefly so the graph can show the handoff, then drop them
      setTimeout(() => {
        const cur = this.live.get(agentId);
        if (cur && cur.handle === handle && (cur.agent.status === "done" || cur.agent.status === "failed")) {
          this.live.delete(agentId);
          this.ctx.agentsChanged(this.agents());
        }
      }, 15_000);
    });
  }
}

function expand(p: string) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}
