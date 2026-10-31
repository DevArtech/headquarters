import { spawn } from "node:child_process";
import type { HarnessAdapter, RunHandle } from "./types.js";

/** Plain shell "harness": the instruction is a command. Useful for scripts, builds, deploys. */
export const shell: HarnessAdapter = {
  id: "shell",
  async detect() {
    return { id: "shell", available: true, version: process.env.SHELL, cloud: false };
  },
  run(opts, emit) {
    return runCmd(opts.instruction, opts.cwd, emit);
  },
  send(_sessionId, text, opts, emit) {
    return runCmd(text, opts.cwd, emit);
  },
};

function runCmd(cmd: string, cwd: string | undefined, emit: Parameters<HarnessAdapter["run"]>[1]): RunHandle {
  const child = spawn(cmd, { shell: true, cwd, stdio: ["ignore", "pipe", "pipe"] });
  emit({ type: "status", payload: "running" });
  let tail = "";
  const onData = (d: Buffer) => {
    const s = d.toString();
    tail = (tail + s).slice(-4000);
    emit({ type: "text", payload: s });
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const done = new Promise<void>((resolve) => {
    child.on("close", (code) => {
      emit(code === 0 ? { type: "result", payload: tail } : { type: "error", payload: `exit ${code}\n${tail}` });
      resolve();
    });
  });
  return { cancel: () => child.kill("SIGTERM"), done };
}
