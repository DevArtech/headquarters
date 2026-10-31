import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent, GarthBrainKind, GarthMessage, GarthState, HqToUi, Notification, Outpost, Settings, Snapshot, Task } from "@hq/protocol";
import { newId } from "@hq/protocol";

export interface BrainChoice {
  kind: GarthBrainKind;
  model?: string;
}

/** A G.A.R.T.H. channel: its own conversation, backed by its own harness session. */
export interface Channel {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  brain?: BrainChoice; // unset = the operator's last choice, else the default
  sessionId?: string; // Claude Code
  codexThread?: string; // Codex
  acpSession?: string; // Antigravity
  transcript: GarthMessage[];
  state: GarthState;
}

const MAX_TRANSCRIPT = 2000; // kept per channel (searchable); the UI receives the most recent slice
const UI_TRANSCRIPT = 150;
export const DEFAULT_CHANNEL = "general";

interface Persisted {
  tasks: Task[];
  notifications: Notification[];
  channels?: Array<Omit<Channel, "state">>;
  lastTurnChannel?: string;
  speaker?: string;
  settings?: Settings;
  // older formats, migrated
  brainDefault?: BrainChoice;
  voice?: { voice: string; speed: number };
  // pre-channels format, migrated into the "General" channel
  transcript?: GarthMessage[];
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
  channels = new Map<string, Channel>();
  /** Channel whose turn ended most recently: where restart / typecheck reports go. */
  lastTurnChannel?: string;
  /**
   * The open page that reads G.A.R.T.H. aloud: the one the operator last spoke from. Every open page
   * would otherwise speak each reply, so the voice repeats once per tab.
   */
  speaker?: string;
  /** Brains installed on this machine, preferred first (set by G.A.R.T.H. at boot). */
  brains: GarthBrainKind[] = [];
  /** Operator settings: defaults for new channels and page loads (see settings.ts). */
  settings: Settings = { startupChannel: "last", voiceOn: true };

  /** Brain for channels without their own choice: the settings default, if any. */
  get brainDefault(): BrainChoice | undefined {
    return this.settings.brain ? { kind: this.settings.brain, ...(this.settings.model ? { model: this.settings.model } : {}) } : undefined;
  }

  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    super();
    this.file = path.join(dataDir, "hq.json");
    fs.mkdirSync(dataDir, { recursive: true });
    const p = readState(this.file);
    if (p) {
      try {
        for (const t of p.tasks ?? []) {
          // anything that was running when HQ died is unknown now
          if (t.status === "running" || t.status === "queued") t.status = "failed", (t.error = "HQ restarted");
          this.tasks.set(t.id, t);
        }
        this.notifications = p.notifications ?? [];
        for (const c of p.channels ?? []) this.channels.set(c.id, { ...c, state: "idle" });
        if (!p.channels && (p.transcript?.length || p.garthSession)) {
          const ts = p.transcript?.[0]?.ts ?? Date.now();
          this.channels.set(DEFAULT_CHANNEL, {
            id: DEFAULT_CHANNEL, name: "General", createdAt: ts, updatedAt: p.transcript?.at(-1)?.ts ?? ts,
            sessionId: p.garthSession, transcript: p.transcript ?? [], state: "idle",
          });
        }
        this.lastTurnChannel = p.lastTurnChannel;
        this.speaker = p.speaker;
        this.settings = {
          ...this.settings,
          ...(p.brainDefault ? { brain: p.brainDefault.kind, model: p.brainDefault.model } : {}),
          ...(p.voice ? { voice: p.voice.voice, voiceSpeed: p.voice.speed } : {}),
          ...p.settings,
        };
      } catch (e) {
        console.error("[world] could not load state:", e);
      }
    }
    if (!this.channels.size) {
      const now = Date.now();
      this.channels.set(DEFAULT_CHANNEL, { id: DEFAULT_CHANNEL, name: "General", createdAt: now, updatedAt: now, transcript: [], state: "idle" });
    }
  }

  /** Overall G.A.R.T.H. state: a pending decision wins, then any channel speaking or thinking. */
  garthState(): GarthState {
    if (this.notifications.some((n) => n.decision && !n.decision.answer)) return "alert";
    const states = [...this.channels.values()].map((c) => c.state);
    return states.includes("speaking") ? "speaking" : states.includes("thinking") ? "thinking" : "idle";
  }

  /** The brain a channel runs on: its own choice, else the last choice, else the preferred one, if installed. */
  brainOf(c: Channel): BrainChoice {
    return [c.brain, this.brainDefault].find((b) => b && this.brains.includes(b.kind)) ?? { kind: this.brains[0] ?? "api" };
  }

  snapshot(): Snapshot {
    return {
      hq: this.hq,
      outposts: [...this.outposts.values()],
      agents: [...this.agents.values()],
      tasks: [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt),
      notifications: [...this.notifications].sort((a, b) => b.ts - a.ts).slice(0, 200),
      garth: {
        state: this.garthState(),
        channels: [...this.channels.values()]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((c) => ({ id: c.id, name: c.name, state: c.state, ...this.brainView(c), updatedAt: c.updatedAt, transcript: c.transcript.slice(-UI_TRANSCRIPT) })),
        brains: this.brains,
        ...(this.speaker ? { speaker: this.speaker } : {}),
      },
      settings: this.settings,
    };
  }

  private brainView(c: Channel) {
    const b = this.brainOf(c);
    return { brain: b.kind, ...(b.model ? { model: b.model } : {}) };
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
    this.changed();
    return full;
  }

  createChannel(name = "New channel"): Channel {
    const now = Date.now();
    const c: Channel = { id: newId("c_"), name, createdAt: now, updatedAt: now, transcript: [], state: "idle" };
    this.channels.set(c.id, c);
    this.changed();
    return c;
  }

  /** Delete a channel and its history. The default channel cannot be deleted. */
  deleteChannel(id: string) {
    if (id === DEFAULT_CHANNEL) throw new Error("General can't be deleted");
    if (!this.channels.delete(id)) throw new Error("no such channel");
    if (this.lastTurnChannel === id) this.lastTurnChannel = undefined;
    this.changed();
  }

  /** The channel with this id, or the default channel when the id is missing or unknown. */
  channel(id?: string): Channel {
    return (id && this.channels.get(id)) || this.channels.get(DEFAULT_CHANNEL) || [...this.channels.values()][0];
  }

  say(channelId: string | undefined, role: GarthMessage["role"], text: string) {
    const c = this.channel(channelId);
    c.transcript.push({ id: newId("m_"), ts: Date.now(), role, text });
    if (c.transcript.length > MAX_TRANSCRIPT) c.transcript.splice(0, c.transcript.length - MAX_TRANSCRIPT);
    c.updatedAt = Date.now();
    this.changed();
  }

  setChannelState(channelId: string, s: GarthState) {
    const c = this.channel(channelId);
    if (c.state !== s) {
      c.state = s;
      this.changed();
    }
  }

  private save() {
    this.saveTimer = null;
    const p: Persisted = {
      tasks: [...this.tasks.values()],
      notifications: this.notifications,
      channels: [...this.channels.values()].map(({ state: _s, ...c }) => c),
      lastTurnChannel: this.lastTurnChannel,
      speaker: this.speaker,
      settings: this.settings,
    };
    // atomic: write a temp file and rename it over the old one, so a restart mid-save can never leave a
    // half-written hq.json; the previous good copy is kept as hq.json.bak
    const tmp = this.file + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(p));
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + ".bak");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("[world] save failed:", err);
    }
  }
}

/**
 * Read saved state. An unreadable hq.json is kept aside (hq.json.corrupt-<time>) and the backup is
 * used instead; starting empty would let the next save overwrite everything.
 */
function readState(file: string): Persisted | null {
  for (const f of [file, file + ".bak"]) {
    if (!fs.existsSync(f)) continue;
    try {
      const p = JSON.parse(fs.readFileSync(f, "utf8")) as Persisted;
      if (f !== file) console.warn(`[world] ${path.basename(file)} was unreadable; recovered state from ${path.basename(f)}`);
      return p;
    } catch (e) {
      if (f === file) {
        const keep = `${file}.corrupt-${Date.now()}`;
        fs.copyFileSync(file, keep);
        console.error(`[world] could not read ${path.basename(file)} (kept as ${path.basename(keep)}):`, (e as Error).message);
      }
    }
  }
  return null;
}
