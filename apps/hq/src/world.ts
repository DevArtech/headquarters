import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent, GarthMessage, GarthState, HqToUi, Notification, Outpost, Snapshot, Task } from "@hq/protocol";
import { newId } from "@hq/protocol";

interface Persisted {
  tasks: Task[];
  notifications: Notification[];
  transcript: GarthMessage[];
  garthSession?: string;
}

/**
 * The whole world in one place. Everything the UI sees comes from `snapshot()`.
 * Mutate, then call `changed()`; the API layer broadcasts and persistence is debounced.
 */
export class World extends EventEmitter {
  hq = { id: "hq", name: os.hostname(), startedAt: Date.now() };
  outposts = new Map<string, Outpost>();
  agents = new Map<string, Agent>();
  tasks = new Map<string, Task>();
  notifications: Notification[] = [];
  garth: { state: GarthState; transcript: GarthMessage[] } = { state: "idle", transcript: [] };
  /** Claude Code session id for G.A.R.T.H., so the conversation survives restarts. */
  garthSession?: string;

  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    super();
    this.file = path.join(dataDir, "hq.json");
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        const p = JSON.parse(fs.readFileSync(this.file, "utf8")) as Persisted;
        for (const t of p.tasks ?? []) {
          // anything that was running when HQ died is unknown now
          if (t.status === "running" || t.status === "queued") t.status = "failed", (t.error = "HQ restarted");
          this.tasks.set(t.id, t);
        }
        this.notifications = p.notifications ?? [];
        this.garth.transcript = p.transcript ?? [];
        this.garthSession = p.garthSession;
      } catch (e) {
        console.error("[world] could not load state:", e);
      }
    }
  }

  snapshot(): Snapshot {
    return {
      hq: this.hq,
      outposts: [...this.outposts.values()],
      agents: [...this.agents.values()],
      tasks: [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt),
      notifications: [...this.notifications].sort((a, b) => b.ts - a.ts).slice(0, 200),
      garth: { state: this.garth.state, transcript: this.garth.transcript.slice(-200) },
    };
  }

  changed() {
    this.emit("change");
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.save(), 250);
  }

  /** Push a non-snapshot message to UI clients (streaming deltas, per-task events). */
  toUi(msg: HqToUi) {
    this.emit("ui", msg);
  }

  notify(n: Omit<Notification, "id" | "ts" | "read">): Notification {
    const full: Notification = { id: newId("n_"), ts: Date.now(), read: false, ...n };
    this.notifications.push(full);
    if (full.decision) this.garth.state = "alert";
    this.changed();
    return full;
  }

  say(role: GarthMessage["role"], text: string) {
    this.garth.transcript.push({ id: newId("m_"), ts: Date.now(), role, text });
    this.changed();
  }

  setGarthState(s: GarthState) {
    if (this.garth.state !== s) {
      this.garth.state = s;
      this.changed();
    }
  }

  private save() {
    this.saveTimer = null;
    const p: Persisted = {
      tasks: [...this.tasks.values()],
      notifications: this.notifications,
      transcript: this.garth.transcript,
      garthSession: this.garthSession,
    };
    fs.writeFile(this.file, JSON.stringify(p), (err) => err && console.error("[world] save failed:", err));
  }
}
