import type { Harness, HarnessInfo, TaskEvent } from "@hq/protocol";

export type Emit = (event: Omit<TaskEvent, "ts"> & { ts?: number }) => void;

export interface RunOpts {
  agentId: string;
  taskId: string;
  instruction: string;
  cwd?: string;
}

export interface RunHandle {
  /** harness-native session id, if the harness has one (used to resume / send follow-ups) */
  sessionId?: string;
  cancel(): void;
  /** resolves when the run has fully finished (after the result/error event) */
  done: Promise<void>;
}

export interface CloudSession {
  id: string;
  title?: string;
  status: "running" | "waiting" | "done" | "failed";
  updatedAt: number;
}

export interface HarnessAdapter {
  id: Harness;
  detect(): Promise<HarnessInfo>;
  run(opts: RunOpts, emit: Emit): RunHandle;
  /** Send a follow-up to a session. Default behaviour is "resume the session with this text as the next turn". */
  send(sessionId: string, text: string, opts: Omit<RunOpts, "instruction">, emit: Emit): RunHandle;
  /** Cloud lane: list sessions this harness is running remotely (web/cloud agents). */
  listCloud?(): Promise<CloudSession[]>;
  /** Cloud lane: start a remote session. */
  runCloud?(opts: RunOpts, emit: Emit): RunHandle;
}
