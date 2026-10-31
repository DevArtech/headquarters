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

const world = new World(path.join(repoRoot, "data"));
const fleet = new Fleet(world);
const tasks = new Tasks(world, fleet);
const garth = new Garth(world, fleet, tasks);

startApi({ world, fleet, tasks, garth, port, token, webDist: path.join(repoRoot, "apps/web/dist") });

// The HQ machine is also a worksite: run an Outpost in-process.
startOutpost({
  url: `ws://127.0.0.1:${port}/ws/outpost`,
  token,
  name: process.env.OUTPOST_NAME ?? `${os.hostname()} (HQ)`,
  embedded: true,
});
