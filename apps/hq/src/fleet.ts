import type { WebSocket } from "ws";
import { OutpostToHq, type Op, type OpArgs, type Request } from "@hq/protocol";
import { newId } from "@hq/protocol";
import type { World } from "./world.js";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Registry of connected Outposts + request/response plumbing over their sockets. */
export class Fleet {
  private sockets = new Map<string, WebSocket>();
  private pending = new Map<string, Pending>();

  constructor(private world: World) {}

  attach(ws: WebSocket) {
    let outpostId: string | null = null;

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = OutpostToHq.parse(JSON.parse(raw.toString()));
      } catch (e) {
        console.warn("[fleet] bad frame:", (e as Error).message);
        return;
      }
      switch (msg.type) {
        case "hello": {
          outpostId = msg.outpost.id;
          this.sockets.get(outpostId)?.close();
          this.sockets.set(outpostId, ws);
          this.world.outposts.set(outpostId, { ...msg.outpost, status: "online", lastSeen: Date.now() });
          console.log(`[fleet] outpost online: ${msg.outpost.name} (${outpostId})`);
          this.world.changed();
          break;
        }
        case "heartbeat": {
          if (!outpostId) return;
          const o = this.world.outposts.get(outpostId);
          if (o) (o.lastSeen = Date.now()), (o.load = msg.load), this.world.changed();
          break;
        }
        case "res": {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error ?? "unknown error"));
          break;
        }
        case "agents": {
          if (!outpostId) return;
          for (const [id, a] of this.world.agents) if (a.outpostId === outpostId) this.world.agents.delete(id);
          for (const a of msg.agents) this.world.agents.set(a.id, a);
          this.world.changed();
          break;
        }
        case "event": {
          this.world.emit("agent.event", msg);
          break;
        }
      }
    });

    ws.on("close", () => {
      if (!outpostId) return;
      if (this.sockets.get(outpostId) === ws) {
        this.sockets.delete(outpostId);
        const o = this.world.outposts.get(outpostId);
        if (o) (o.status = "offline"), this.world.changed();
        console.log(`[fleet] outpost offline: ${outpostId}`);
      }
    });
  }

  request<K extends Op>(outpostId: string, op: K, args: OpArgs<K>, timeoutMs = 30_000): Promise<unknown> {
    const ws = this.sockets.get(outpostId);
    if (!ws || ws.readyState !== ws.OPEN) return Promise.reject(new Error(`outpost ${outpostId} is offline`));
    const req: Request = { type: "req", id: newId("r_"), op, args };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        reject(new Error(`request ${op} to ${outpostId} timed out`));
      }, timeoutMs);
      this.pending.set(req.id, { resolve, reject, timer });
      ws.send(JSON.stringify(req));
    });
  }

  online(): string[] {
    return [...this.sockets.keys()];
  }
}
