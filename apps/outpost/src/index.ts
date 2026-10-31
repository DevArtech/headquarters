#!/usr/bin/env tsx
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { HqToOutpost, Ops as OpSchemas, type OutpostToHq, type Outpost as OutpostInfo } from "@hq/protocol";
import { adapters } from "./harness/index.js";
import { Ops } from "./ops.js";
export { cleanEnv, which } from "./harness/proc.js";

export interface OutpostOptions {
  url: string; // ws://host:port/ws/outpost
  token: string;
  name?: string;
  embedded?: boolean;
  idFile?: string; // where to persist this outpost's stable id
}

/** Start an Outpost that dials HQ and keeps reconnecting. Returns a stop() function. */
export function startOutpost(opts: OutpostOptions) {
  const id = stableId(opts.idFile ?? path.join(os.homedir(), ".hq-outpost-id"), opts.embedded);
  const name = opts.name ?? os.hostname();
  let ws: WebSocket | null = null;
  let stopped = false;
  let backoff = 1000;

  const send = (m: OutpostToHq) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
  const ops = new Ops({
    outpostId: id,
    emitEvent: (taskId, agentId, event) => send({ type: "event", taskId, agentId, event }),
    agentsChanged: (agents) => send({ type: "agents", agents }),
  });

  async function describe(): Promise<Omit<OutpostInfo, "status" | "lastSeen">> {
    const harnesses = await Promise.all(Object.values(adapters).map((a) => a.detect()));
    return { id, name, platform: `${os.platform()} ${os.arch()}`, hostname: os.hostname(), home: os.homedir(), harnesses, embedded: !!opts.embedded };
  }

  async function connect() {
    if (stopped) return;
    const url = new URL(opts.url);
    url.searchParams.set("token", opts.token);
    ws = new WebSocket(url);
    const log = (m: string) => console.log(`[outpost:${name}] ${m}`);

    ws.on("open", async () => {
      backoff = 1000;
      send({ type: "hello", outpost: await describe() });
      send({ type: "agents", agents: ops.agents() });
      log(`connected to ${opts.url}`);
    });
    ws.on("message", async (raw) => {
      let m;
      try {
        m = HqToOutpost.parse(JSON.parse(raw.toString()));
      } catch (e) {
        return log(`bad frame: ${(e as Error).message}`);
      }
      if (m.type !== "req") return;
      try {
        const args = OpSchemas[m.op].args.parse(m.args);
        const data = await ops.handle(m.op, args as never);
        send({ type: "res", id: m.id, ok: true, data });
      } catch (e) {
        send({ type: "res", id: m.id, ok: false, error: (e as Error).message });
      }
    });
    ws.on("close", () => {
      if (stopped) return;
      log(`disconnected; retrying in ${backoff}ms`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
    ws.on("error", (e) => log(`socket error: ${e.message}`));
  }

  const hb = setInterval(() => send({ type: "heartbeat", load: os.loadavg()[0] / os.cpus().length }), 10_000);
  connect();
  return () => {
    stopped = true;
    clearInterval(hb);
    ws?.close();
  };
}

function stableId(file: string, embedded?: boolean) {
  if (embedded) return "hq-local";
  try {
    return fs.readFileSync(file, "utf8").trim() || crypto.randomUUID();
  } catch {
    const id = "op_" + crypto.randomBytes(5).toString("hex");
    fs.writeFileSync(file, id);
    return id;
  }
}

// CLI entry: `pnpm outpost` / `tsx src/index.ts`
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const f of [path.resolve(here, "../../../.env"), path.resolve(here, "../.env")]) if (fs.existsSync(f)) process.loadEnvFile(f);
  const url = process.env.HQ_URL ?? "ws://127.0.0.1:4800/ws/outpost";
  const token = process.env.HQ_TOKEN ?? "dev-token";
  startOutpost({ url, token, name: process.env.OUTPOST_NAME });
}
