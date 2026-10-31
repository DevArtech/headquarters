import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { HqToUi } from "@hq/protocol";
import { synthesize, voiceStatus } from "./voice.js";
import type { Fleet } from "./fleet.js";
import type { Garth } from "./garth.js";
import type { Tasks } from "./tasks.js";
import type { World } from "./world.js";

export interface ApiDeps { world: World; fleet: Fleet; tasks: Tasks; garth: Garth; port: number; token: string; webDist: string }

export function startApi({ world, fleet, tasks, garth, port, token, webDist }: ApiDeps) {
  const app = new Hono();
  const json = (c: { json: (v: unknown, s?: 200 | 400 | 404) => Response }, fn: () => Promise<unknown> | unknown) =>
    Promise.resolve()
      .then(fn)
      .then((v) => c.json(v ?? { ok: true }))
      .catch((e) => c.json({ error: (e as Error).message }, 400));

  app.get("/api/state", (c) => c.json(world.snapshot()));

  app.post("/api/garth", async (c) => {
    const { text } = await c.req.json<{ text: string }>();
    garth.handleUser(text);
    return c.json({ ok: true });
  });

  // G.A.R.T.H.'s tools, called by the MCP bridge that Claude Code spawns. Bearer-token protected.
  const authed = (h?: string) => h?.replace(/^Bearer /, "") === token;
  app.get("/api/garth/tools", (c) => (authed(c.req.header("authorization")) ? c.json(garth.tools()) : c.json({ error: "unauthorized" }, 401 as 400)));
  app.post("/api/garth/tools/:name", async (c) => {
    if (!authed(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401 as 400);
    const input = await c.req.json().catch(() => ({}));
    return garth
      .callTool(c.req.param("name"), input)
      .then((result) => c.json({ result: result ?? "ok" }))
      .catch((e) => c.json({ error: (e as Error).message }, 400));
  });

  // G.A.R.T.H.'s neural voice: one sentence in, a WAV file out
  app.get("/api/tts", (c) => c.json(voiceStatus()));
  app.post("/api/tts", async (c) => {
    const { text, voice } = await c.req.json<{ text: string; voice?: string }>();
    if (!text?.trim()) return c.json({ error: "no text" }, 400);
    try {
      const wav = await synthesize(text.slice(0, 1000), voice);
      return new Response(wav, { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 503 as 400);
    }
  });

  // performance reports from the UI's ?diag run, appended to data/diag.jsonl
  app.post("/api/diag", async (c) => {
    const report = await c.req.json().catch(() => null);
    if (report) fs.appendFileSync(path.join(path.dirname(webDist), "../../data/diag.jsonl"), JSON.stringify(report) + "\n");
    return c.json({ ok: true });
  });

  app.post("/api/tasks", async (c) => {
    const body = await c.req.json();
    return json(c, async () => {
      const task = tasks.create({ ...body, createdBy: "user" });
      return tasks.dispatch(task);
    });
  });
  app.post("/api/tasks/:id/cancel", (c) => json(c, () => tasks.cancel(c.req.param("id"))));
  app.post("/api/tasks/:id/send", async (c) => {
    const { text } = await c.req.json<{ text: string }>();
    return json(c, () => tasks.send(c.req.param("id"), text));
  });

  app.post("/api/notifications/:id/read", (c) =>
    json(c, () => {
      const n = world.notifications.find((n) => n.id === c.req.param("id"));
      if (n) (n.read = true), world.changed();
    }),
  );
  app.post("/api/notifications/:id/answer", async (c) => {
    const { answer } = await c.req.json<{ answer: string }>();
    return json(c, () => {
      const n = world.notifications.find((n) => n.id === c.req.param("id"));
      if (!n?.decision) throw new Error("not a decision");
      n.decision.answer = answer;
      n.read = true;
      world.changed();
      garth.handleDecision(n.decision.question, answer, n.taskId);
    });
  });

  app.post("/api/outposts/:id/fs", async (c) => {
    const { op, path: p, content } = await c.req.json<{ op: "list" | "read" | "write"; path: string; content?: string }>();
    return json(c, () =>
      op === "write"
        ? fleet.request(c.req.param("id"), "fs.write", { path: p, content: content ?? "" })
        : fleet.request(c.req.param("id"), op === "list" ? "fs.list" : "fs.read", { path: p }),
    );
  });
  app.post("/api/outposts/:id/exec", async (c) => {
    const { cmd, cwd } = await c.req.json<{ cmd: string; cwd?: string }>();
    return json(c, () => fleet.request(c.req.param("id"), "exec", { cmd, cwd, timeoutMs: 60_000 }, 65_000));
  });

  if (fs.existsSync(webDist)) {
    const root = path.relative(process.cwd(), webDist);
    app.use("/*", serveStatic({ root }));
    app.get("*", serveStatic({ root, path: "index.html" }));
  } else {
    app.get("/", (c) => c.text("Headquarters is running. Web UI not built: run `pnpm --filter @hq/web dev` (dev) or `pnpm build`."));
  }

  const server = serve({ fetch: app.fetch, port }, () => console.log(`[hq] http://localhost:${port}`));

  // ── WebSockets: /ws/ui (browser) and /ws/outpost (devices) ──
  const wss = new WebSocketServer({ noServer: true });
  const uiClients = new Set<WebSocket>();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/ws/ui") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        uiClients.add(ws);
        ws.send(JSON.stringify({ type: "snapshot", state: world.snapshot() } satisfies HqToUi));
        ws.on("close", () => uiClients.delete(ws));
      });
    } else if (url.pathname === "/ws/outpost") {
      const presented = url.searchParams.get("token") ?? req.headers.authorization?.replace(/^Bearer /, "");
      if (presented !== token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => fleet.attach(ws));
    } else {
      socket.destroy();
    }
  });

  const broadcast = (msg: HqToUi) => {
    const data = JSON.stringify(msg);
    for (const ws of uiClients) if (ws.readyState === ws.OPEN) ws.send(data);
  };
  let snapTimer: NodeJS.Timeout | null = null;
  world.on("change", () => {
    if (snapTimer) return;
    snapTimer = setTimeout(() => {
      snapTimer = null;
      broadcast({ type: "snapshot", state: world.snapshot() });
    }, 30);
  });
  world.on("ui", broadcast);

  return server;
}
