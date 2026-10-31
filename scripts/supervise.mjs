#!/usr/bin/env node
/**
 * Process supervisor for Headquarters and Outposts. No dependencies.
 *
 *   node scripts/supervise.mjs --entry src/index.ts --watch src,../outpost/src [--typecheck "pnpm -r typecheck"] [--root ../..]
 *
 * - Runs the entry with `node --import tsx` and restarts it when watched code changes.
 * - Defers restarts while the child reports busy (G.A.R.T.H. mid-turn or local agent runs).
 * - Optional typecheck gate: if it fails, the running process keeps its old code and is told why.
 * - Boot watchdog: if a restart caused by G.A.R.T.H.'s edits crashes before "ready", the files it
 *   changed are stashed with `git stash push` (recoverable) and the previous code is restarted.
 * - Exit code 75 from the child means "restart me now".
 */
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const entry = arg("entry", "src/index.ts");
const watch = (arg("watch", "src") || "").split(",").filter(Boolean).map((d) => path.resolve(d));
const typecheck = arg("typecheck");
const root = path.resolve(arg("root", "."));
const name = arg("name", path.basename(process.cwd()));
const log = (m) => console.log(`\x1b[36m[supervise:${name}]\x1b[0m ${m}`);

let child = null;
let ready = false;
let busy = false;
let garthBusy = false;
let pending = null; // { reason, byGarth } when a restart is waiting
let changed = new Set(); // files changed since the running process started
let garthChanged = new Set(); // ...of which, changed while G.A.R.T.H. was mid-turn
let crashes = 0;
let lastStart = 0;
let stopping = false;
let restarting = false;
let stderrTail = "";
let ignoreUntil = 0; // ignore file events caused by our own git stash

function start(env = {}) {
  ready = false;
  busy = false;
  garthBusy = false;
  stderrTail = "";
  lastStart = Date.now();
  child = spawn(process.execPath, ["--import", "tsx", entry], {
    stdio: ["inherit", "inherit", "pipe", "ipc"],
    env: { ...process.env, ...env },
  });
  child.stderr.on("data", (d) => {
    process.stderr.write(d);
    stderrTail = (stderrTail + d.toString()).slice(-3000);
  });
  child.on("message", (m) => {
    if (m?.type === "ready") {
      ready = true;
      crashes = 0;
      changed = new Set();
      garthChanged = new Set();
    } else if (m?.type === "busy") {
      busy = !!m.busy;
      garthBusy = !!m.garth;
      if (!busy && pending) maybeRestart();
    }
  });
  const me = child;
  child.on("exit", (code, signal) => onExit(me, code, signal));
}

async function onExit(me, code, signal) {
  if (me !== child) return;
  child = null;
  if (stopping) process.exit(0);
  if (restarting) return; // a planned restart spawns the next process itself
  if (code === 75) return start({ HQ_RESTART_REASON: "restart requested" });

  const bootFailed = !ready;
  log(`process exited (${signal ?? code})${bootFailed ? " before becoming ready" : ""}`);
  if (bootFailed && garthChanged.size) {
    const files = [...garthChanged];
    const msg = `hq-autorevert ${new Date().toISOString()}`;
    ignoreUntil = Date.now() + 60_000;
    const ok = await git(["stash", "push", "--include-untracked", "-m", msg, "--", ...files]);
    ignoreUntil = Date.now() + 1500;
    garthChanged = new Set();
    changed = new Set();
    const crash = stderrTail.trim().split("\n").slice(-12).join("\n");
    if (ok) {
      log(`rolled back ${files.length} file(s) changed by G.A.R.T.H. into git stash "${msg}"`);
      return start({
        HQ_ROLLBACK: `Stashed as "${msg}" (git stash list; git stash show -p) — files: ${files.map((f) => path.relative(root, f)).join(", ")}\nCrash output:\n${crash}`,
      });
    }
    log("rollback failed; waiting for a code change before retrying");
    return;
  }
  // crash loop protection: back off, and after repeated boot failures wait for the code to change
  crashes++;
  if (bootFailed && crashes >= 3) return log("failing to start repeatedly; waiting for a code change before retrying");
  const delay = Math.min(30_000, 1000 * 2 ** (crashes - 1));
  log(`restarting in ${delay}ms`);
  setTimeout(() => !child && start({ HQ_RESTART_REASON: "recovered from a crash" }), delay);
}

function git(args) {
  return new Promise((resolve) => execFile("git", args, { cwd: root }, (err, out, errOut) => {
    if (err) log(`git ${args[0]} failed: ${(errOut || err.message).trim()}`);
    resolve(!err);
  }));
}

function runTypecheck() {
  return new Promise((resolve) => {
    log(`typechecking: ${typecheck}`);
    execFile("/bin/sh", ["-c", typecheck], { cwd: root, maxBuffer: 4_000_000 }, (err, out, errOut) => {
      resolve({ ok: !err, output: `${out}\n${errOut}`.split("\n").filter((l) => /error|Error|failed/.test(l)).slice(-40).join("\n") });
    });
  });
}

async function maybeRestart() {
  if (!pending || restarting) return;
  if (!child) {
    const p = pending;
    pending = null;
    return start({ HQ_RESTART_REASON: p.reason });
  }
  if (busy) return log("change detected; restart deferred until Headquarters is idle");
  const p = pending;
  pending = null;
  if (typecheck) {
    const tc = await runTypecheck();
    if (!tc.ok) {
      log("typecheck failed; keeping the running process on its current code");
      child?.send?.({ type: "typecheck_failed", output: tc.output, byGarth: p.byGarth });
      return;
    }
  }
  restarting = true;
  log(`restarting (${p.reason})`);
  const old = child;
  await new Promise((resolve) => {
    old.once("exit", resolve);
    old.kill("SIGTERM");
    setTimeout(() => old.kill("SIGKILL"), 5000);
  });
  restarting = false;
  start({ HQ_RESTART_REASON: p.reason, ...(p.byGarth ? { HQ_RESTART_BY_GARTH: "1" } : {}) });
}

// ── file watching ──
let debounce = null;
for (const dir of watch) {
  if (!fs.existsSync(dir)) continue;
  fs.watch(dir, { recursive: true }, (_ev, file) => {
    if (!file || /node_modules|dist|\.DS_Store|~$|\.swp$/.test(file) || Date.now() < ignoreUntil) return;
    const full = path.join(dir, file);
    changed.add(full);
    if (garthBusy) garthChanged.add(full);
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const byGarth = garthChanged.size > 0;
      pending = { reason: byGarth ? "code changed by G.A.R.T.H." : "code changed", byGarth };
      crashes = 0;
      maybeRestart();
    }, 400);
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    if (!child) process.exit(0);
    child.kill(sig);
    setTimeout(() => process.exit(0), 5000);
  });
}

log(`watching ${watch.map((d) => path.relative(root, d) || ".").join(", ")}`);
start();
