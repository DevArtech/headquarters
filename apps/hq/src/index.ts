import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { startOutpost } from "@hq/outpost";
import { startApi } from "./api.js";
import { Fleet } from "./fleet.js";
import { Garth } from "./garth.js";
import { Tasks } from "./tasks.js";
import { World } from "./world.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
for (const f of [path.join(repoRoot, ".env"), path.join(here, "../.env")]) {
  if (fs.existsSync(f)) process.loadEnvFile(f);
}

const port = Number(process.env.HQ_PORT ?? 4800);
const token = process.env.HQ_TOKEN ?? "dev-token";
if (token === "dev-token") console.warn("[hq] HQ_TOKEN not set; using 'dev-token'. Set it in .env before exposing HQ.");

/** Messages to/from scripts/supervise.mjs when running under it (IPC channel present). */
const supervisor = typeof process.send === "function";
const toSupervisor = (m: object) => supervisor && process.send!(m);

const world = new World(path.join(repoRoot, "data"));
const fleet = new Fleet(world);
const tasks = new Tasks(world, fleet);
const garth = new Garth(world, fleet, tasks, { repoRoot, hqApi: `http://127.0.0.1:${port}`, hqToken: token, supervised: supervisor });

const server = startApi({ world, fleet, tasks, garth, port, token, webDist: path.join(repoRoot, "apps/web/dist") });
server.on("listening", () => toSupervisor({ type: "ready" }));

// The HQ machine is also a worksite: run an Outpost in-process.
startOutpost({
  url: `ws://127.0.0.1:${port}/ws/outpost`,
  token,
  name: process.env.OUTPOST_NAME ?? `${os.hostname()} (HQ)`,
  embedded: true,
});

// ── self-modification support ──────────────────────────────────────────
// Busy = G.A.R.T.H. mid-turn, or agent runs on this machine that a restart would kill.
// The supervisor defers code-change restarts until we are idle.
let lastBusy: boolean | null = null;
const reportBusy = () => {
  const localWork = [...world.tasks.values()].some((t) => t.outpostId === "hq-local" && (t.status === "running" || t.status === "queued"));
  const busy = garth.busy || localWork;
  if (busy !== lastBusy) toSupervisor({ type: "busy", busy, garth: garth.busy });
  lastBusy = busy;
};
world.on("change", reportBusy);
world.on("garth.busy", reportBusy);

process.on("message", (m: { type: string; output?: string; byGarth?: boolean }) => {
  if (m.type === "typecheck_failed") {
    world.notify({ level: "error", title: "Code change not applied: typecheck failed", body: "Headquarters is still running the previous code." });
    if (m.byGarth) garth.event(`Typecheck failed after your edits, so Headquarters did not restart and is still running the previous code. Fix these errors, then run the typecheck again:\n${m.output}`);
  }
});

if (process.env.HQ_ROLLBACK) {
  const info = process.env.HQ_ROLLBACK;
  world.notify({ level: "error", title: "Reverted a change that broke Headquarters", body: info.split("\n")[0] });
  garth.event(`Your last code change made Headquarters crash on startup, so it was rolled back and the previous code is running. ${info}\nInspect the stash, fix the problem, and reapply it.`);
} else if (process.env.HQ_RESTART_REASON) {
  world.say("system", `Headquarters restarted (${process.env.HQ_RESTART_REASON}).`);
  if (process.env.HQ_RESTART_BY_GARTH) garth.event("Headquarters restarted on your updated code and is healthy. Briefly confirm to the operator what changed.");
}
