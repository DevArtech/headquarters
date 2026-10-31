import type { Harness } from "@hq/protocol";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { shell } from "./shell.js";
import type { HarnessAdapter } from "./types.js";

export const adapters: Record<Harness, HarnessAdapter> = { claude, codex, shell };
export * from "./types.js";
