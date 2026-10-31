import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import readline from "node:readline";
import type { RunHandle } from "./types.js";

export function which(bin: string): Promise<string | null> {
  return new Promise((resolve) => execFile("which", [bin], (err, out) => resolve(err ? null : out.trim() || null)));
}

export function version(bin: string, args = ["--version"]): Promise<string | undefined> {
  return new Promise((resolve) => execFile(bin, args, { timeout: 5000 }, (err, out) => resolve(err ? undefined : out.trim().split("\n")[0])));
}

/** Spawn a process and hand each stdout line to `onLine`; builds a RunHandle. */
export function lineProcess(
  bin: string,
  args: string[],
  opts: { cwd?: string; stdin?: string; env?: NodeJS.ProcessEnv },
  onLine: (line: string) => void,
  onExit: (code: number | null, stderr: string) => void,
): { child: ChildProcess; handle: Omit<RunHandle, "sessionId"> } {
  const child = spawn(bin, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d.toString().slice(0, 4000)));
  const rl = readline.createInterface({ input: child.stdout! });
  rl.on("line", onLine);
  if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  else child.stdin?.end();
  const done = new Promise<void>((resolve) => {
    child.on("close", (code) => {
      onExit(code, stderr);
      resolve();
    });
    child.on("error", (e) => {
      onExit(-1, e.message);
      resolve();
    });
  });
  return { child, handle: { cancel: () => child.kill("SIGTERM"), done } };
}
