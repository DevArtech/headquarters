import { GarthBrainKind, type Settings } from "@hq/protocol";
import { setVoice, voiceConfig } from "./voice.js";
import type { World } from "./world.js";

const HARNESS: Record<GarthBrainKind, string> = { "claude-code": "Claude Code", codex: "Codex", api: "Claude API" };
const STARTUP = ["last", "general", "new"];

/** A change to the settings. null clears an optional field back to its default. */
export type SettingsPatch = {
  brain?: GarthBrainKind | null;
  model?: string | null;
  startupChannel?: string;
  voice?: string | null;
  voiceSpeed?: number | null;
  voiceOn?: boolean;
};

/**
 * Validate and apply a settings change from the panel or from G.A.R.T.H. Settings are defaults:
 * the brain applies to channels created afterwards (existing channels keep the brain they run on),
 * the startup channel and voiceOn apply when the UI is loaded, and the voice applies from the next
 * sentence spoken.
 */
export async function updateSettings(world: World, patch: SettingsPatch): Promise<Settings> {
  const next: Settings = { ...world.settings };

  if (patch.brain !== undefined) {
    if (patch.brain === null) delete next.brain;
    else {
      if (!GarthBrainKind.safeParse(patch.brain).success) throw new Error(`unknown brain "${patch.brain}" (one of: ${GarthBrainKind.options.join(", ")})`);
      if (!world.brains.includes(patch.brain)) throw new Error(`${HARNESS[patch.brain]} isn't installed here (available: ${world.brains.join(", ")})`);
      next.brain = patch.brain;
    }
    // a different brain makes the old model meaningless unless one is given alongside it
    if (patch.model === undefined && next.brain !== world.settings.brain) delete next.model;
  }
  if (patch.model !== undefined) {
    if (patch.model === null || !patch.model.trim()) delete next.model;
    else next.model = patch.model.trim();
  }
  if (patch.startupChannel !== undefined) {
    const v = patch.startupChannel.trim();
    if (!STARTUP.includes(v) && !world.channels.has(v)) throw new Error(`startupChannel must be "last", "general", "new" or a channel id`);
    next.startupChannel = v;
  }
  if (patch.voiceOn !== undefined) next.voiceOn = !!patch.voiceOn;
  if (patch.voice !== undefined || patch.voiceSpeed !== undefined) {
    const now = await setVoice({
      voice: patch.voice === null ? process.env.GARTH_VOICE ?? "am_michael" : patch.voice ?? undefined,
      speed: patch.voiceSpeed === null ? Number(process.env.GARTH_VOICE_SPEED ?? 1.05) : patch.voiceSpeed ?? undefined,
    });
    if (patch.voice !== undefined) patch.voice === null ? delete next.voice : (next.voice = now.voice);
    if (patch.voiceSpeed !== undefined) patch.voiceSpeed === null ? delete next.voiceSpeed : (next.voiceSpeed = now.speed);
  }

  // existing channels keep the brain they run on; only channels created from now on use the new default
  if (next.brain !== world.settings.brain || next.model !== world.settings.model) {
    for (const c of world.channels.values()) c.brain ??= world.brainOf(c);
  }
  world.settings = next;
  world.changed();
  return next;
}

/** Apply saved voice settings at boot (before the voice model is loaded). */
export function applyVoiceSettings(s: Settings) {
  if (s.voice) voiceConfig.voice = s.voice;
  if (s.voiceSpeed) voiceConfig.speed = s.voiceSpeed;
}
