import type { HarnessAdapter, RunHandle } from "./types.js";
import { lineProcess, version, which } from "./proc.js";

/**
 * Claude Code adapter. Runs `claude -p` in stream-json mode and maps its NDJSON to task events.
 * Follow-ups resume the same session with `--resume`.
 * Extra flags via CLAUDE_ARGS (e.g. "--permission-mode bypassPermissions" on a trusted box).
 */
export const claude: HarnessAdapter = {
  id: "claude",
  async detect() {
    const bin = await which("claude");
    return { id: "claude", available: !!bin, version: bin ? await version("claude") : undefined, cloud: false };
  },
  run(opts, emit) {
    return launch(["-p", opts.instruction], opts.cwd, emit);
  },
  send(sessionId, text, opts, emit) {
    return launch(["-p", "--resume", sessionId, text], opts.cwd, emit);
  },
  // TODO(M3): Claude Code web/cloud sessions. No stable CLI surface to enumerate them yet;
  // when there is, implement listCloud()/runCloud() here and set `cloud: true` in detect().
};

function launch(args: string[], cwd: string | undefined, emit: Parameters<HarnessAdapter["run"]>[1]): RunHandle {
  const extra = (process.env.CLAUDE_ARGS ?? "--permission-mode acceptEdits").split(/\s+/).filter(Boolean);
  const full = [...args, "--output-format", "stream-json", "--verbose", ...extra];
  let sessionId: string | undefined;
  let gotResult = false;

  const { handle } = lineProcess(
    "claude",
    full,
    { cwd },
    (line) => {
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      if (j.type === "system" && j.subtype === "init") {
        sessionId = j.session_id as string;
        emit({ type: "status", payload: "running" });
        emit({ type: "session", payload: { sessionId, model: j.model, tools: (j.tools as string[] | undefined)?.length } });
      } else if (j.type === "assistant") {
        const msg = j.message as { content?: Array<Record<string, unknown>> };
        for (const b of msg.content ?? []) {
          if (b.type === "text") emit({ type: "text", payload: b.text });
          else if (b.type === "tool_use") emit({ type: "tool_use", payload: { name: b.name, input: b.input } });
        }
      } else if (j.type === "user") {
        const msg = j.message as { content?: Array<Record<string, unknown>> };
        for (const b of msg.content ?? []) if (b.type === "tool_result") emit({ type: "tool_result", payload: summarize(b.content) });
      } else if (j.type === "result") {
        gotResult = true;
        if (j.is_error || j.subtype !== "success") emit({ type: "error", payload: String(j.result ?? j.subtype) });
        else emit({ type: "result", payload: String(j.result ?? "") });
      }
    },
    (code, stderr) => {
      if (!gotResult) emit({ type: "error", payload: code === 0 ? "claude exited without a result" : `claude exited ${code}: ${stderr.slice(-800)}` });
    },
  );
  return { get sessionId() { return sessionId; }, ...handle };
}

function summarize(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 500);
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("").slice(0, 500);
  return "";
}
