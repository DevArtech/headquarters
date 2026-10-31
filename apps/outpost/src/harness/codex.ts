import type { HarnessAdapter, RunHandle } from "./types.js";
import { lineProcess, version, which } from "./proc.js";

/**
 * Codex CLI adapter (best effort — verify against your installed `codex exec --json` event shape).
 * Follow-ups use `codex exec resume <sessionId>`.
 */
export const codex: HarnessAdapter = {
  id: "codex",
  async detect() {
    const bin = await which("codex");
    return { id: "codex", available: !!bin, version: bin ? await version("codex") : undefined, cloud: false };
  },
  run(opts, emit) {
    return launch(["exec", "--json", opts.instruction], opts.cwd, emit);
  },
  send(sessionId, text, opts, emit) {
    return launch(["exec", "resume", "--json", sessionId, text], opts.cwd, emit);
  },
  // TODO(M3): Codex cloud tasks — enumerate/dispatch via the Codex cloud API when available.
};

function launch(args: string[], cwd: string | undefined, emit: Parameters<HarnessAdapter["run"]>[1]): RunHandle {
  const extra = (process.env.CODEX_ARGS ?? "").split(/\s+/).filter(Boolean);
  let sessionId: string | undefined;
  let last = "";
  let finished = false;
  const { handle } = lineProcess(
    "codex",
    [...args, ...extra],
    { cwd },
    (line) => {
      let j: Record<string, any>;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      if (j.type === "thread.started") (sessionId = j.thread_id), emit({ type: "status", payload: "running" });
      else if (j.type === "item.completed" && j.item?.type === "agent_message") (last = j.item.text ?? ""), emit({ type: "text", payload: last });
      else if (j.type === "item.completed" && j.item?.type === "command_execution") emit({ type: "tool_use", payload: { name: "command", input: j.item.command } });
      else if (j.type === "turn.completed") (finished = true), emit({ type: "result", payload: last });
      else if (j.type === "turn.failed" || j.type === "error") (finished = true), emit({ type: "error", payload: j.error?.message ?? j.message ?? "codex failed" });
    },
    (code, stderr) => {
      if (!finished) emit(code === 0 ? { type: "result", payload: last } : { type: "error", payload: `codex exited ${code}: ${stderr.slice(-800)}` });
    },
  );
  return { get sessionId() { return sessionId; }, ...handle };
}
