# Headquarters

Command center for agent harnesses (Claude Code, Codex, shell) across your devices.
Talk to **G.A.R.T.H.** (General Agent for Routing, Tasking & Handoffs); it distributes work to Outposts and comes back with results and decisions.

See [PLAN.md](PLAN.md) for architecture and milestones, [SUGGESTIONS.md](SUGGESTIONS.md) for the feature wishlist.

## Run it

```bash
cp .env.example .env     # set HQ_TOKEN
claude auth login        # G.A.R.T.H. and Claude Code tasks use this machine's Claude Code login
pnpm install
pnpm dev                 # supervised HQ on :4800 (with embedded local Outpost) + Vite UI on :5180
```

Open http://localhost:5180. Production-style: `pnpm build && pnpm hq` serves the built UI from :4800.

## Add another device

On the other machine:

```bash
git clone <this repo> && cd headquarters && pnpm install
HQ_URL=ws://<hq-host>:4800/ws/outpost HQ_TOKEN=<token> OUTPOST_NAME=my-laptop pnpm outpost
```

It appears on the graph within a second. Put HQ on a tailnet or VPN rather than the open internet.

## Layout

| Path | What |
|---|---|
| `packages/protocol` | Shared zod schemas: domain model + wire protocol |
| `apps/hq` | Headquarters server: fleet registry, task lifecycle, G.A.R.T.H., HTTP/WS API |
| `apps/outpost` | Outpost daemon: dials HQ, runs fs/exec ops and harness adapters |
| `apps/web` | Node-graph UI (React + React Flow) |

## G.A.R.T.H.

- **Brain**: a persistent agent-harness session on the HQ machine, working in this repo. Four brains, chosen per channel:
  - **Claude Code** (`apps/hq/src/garth-cc.ts`): `claude -p` in stream-json mode.
  - **Codex** (`apps/hq/src/garth-codex.ts`): `codex app-server` over JSON-RPC (the protocol T3 Code uses). Runs with approvals off in Codex's `workspace-write` sandbox (network on); your own Codex MCP servers and plugins are left out.
  - **Antigravity** (`apps/hq/src/garth-acp.ts`): Google's Antigravity agent over ACP (Agent Client Protocol), with Gemini models. It's a separate install from the Antigravity editor: unzip `agy-acp-server-<version>-darwin-arm64.zip` from Google (`https://dl.google.com/agy-extensions/releases/macos/`, the build the ACP Registry lists) into `~/.local/share/antigravity-acp/<version>/`, then sign in once (run the agent and call ACP `authenticate` with `oauth-personal`, or use a Gemini API key). Its sign-in and settings live in a private `GEMINI_HOME` (`~/.local/share/antigravity-acp/profile`). It only shows as available once signed in. Tool permission requests are granted, as for the other harnesses.
  - **Claude API** (`ANTHROPIC_API_KEY`): no repo access; the fallback when no harness is installed.

  Fleet tools reach the harnesses through a dependency-free MCP bridge (`apps/hq/bin/mcp-bridge.mjs` → `/api/garth/tools`). Session and thread ids are saved per channel in `data/hq.json`, so conversations survive restarts. Switch the current channel's brain by asking G.A.R.T.H. ("use Codex here") or with `POST /api/channels/:id/brain {kind, model?}`; it changes over after the current reply and the new harness gets a recap of the conversation. New channels start on the brain set in Settings. Installed brains are detected at boot (`GARTH_BRAIN` picks the preferred one; the Codex CLI ships inside ChatGPT.app at `Contents/Resources/codex-cli/bin/codex` if it isn't on your PATH).
- **Settings** (gear, top right, or just ask G.A.R.T.H.): the defaults for new channels and page loads — brain and model for new channels, which channel opens on load (last used, General, a new one, or a specific channel), voice, speed, and whether speech starts on. Saved in `data/hq.json`; `GET/POST /api/settings`. Existing channels keep their brain when the default changes; the mute button lasts until reload.
- **Channels**: separate conversations with G.A.R.T.H., each its own harness session (switch or create from the `#` chip in the command bar; hover a channel to delete it). Channels run in parallel; task results, decisions and restart reports go back to the channel that started them. G.A.R.T.H. names new channels itself and can `search_channels` / `read_channel` to pull context from other conversations. Idle sessions shut down after 10 minutes and resume on the next message.
- **Voice**: replies stream token by token to the UI and are spoken sentence by sentence by [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), an open-weight neural TTS model running locally on the HQ machine (`apps/hq/src/voice.ts`, `POST /api/tts`). The browser fetches each sentence while the previous one plays and schedules them gaplessly. The model (~330 MB) downloads once on first start. Falls back to the browser's built-in voice if unavailable or with `GARTH_TTS=browser`. Toggle with the speaker button; Esc stops speech.
- **Self-modification**: G.A.R.T.H. may edit Headquarters, Outposts, the UI, and itself. `pnpm dev` runs HQ under `scripts/supervise.mjs`, which:
  - restarts on changes to `apps/hq`, `apps/outpost`, `packages/protocol`, but waits while G.A.R.T.H. is mid-turn or agents are running on this machine;
  - typechecks first; on failure the old code keeps running and G.A.R.T.H. is sent the errors;
  - if new code from G.A.R.T.H. crashes on boot, stashes just the files it changed (`git stash list`, look for `hq-autorevert`) and restarts on the previous code.
  - `apps/web` changes hot-reload without a restart.
- Voice settings: `GARTH_VOICE` (default `am_michael`; most natural overall: `af_heart`, `af_bella`), `GARTH_VOICE_SPEED` (default `1.05`). You can also just ask G.A.R.T.H. ("switch to a British voice", "talk a little faster"); it changes live via its `set_voice` tool and the choice is saved in `data/hq.json`, overriding `.env`.
- Claude Code settings: `GARTH_ALLOWED_TOOLS` (default `mcp__hq Bash Read Edit Write Glob Grep WebSearch WebFetch`), `GARTH_PERMISSION_MODE` (default `acceptEdits`), `GARTH_CC_MODEL`, `GARTH_CLAUDE_BIN`.
- Antigravity settings: `GARTH_ANTIGRAVITY_MODEL` (default: the agent's, Gemini 3.8 Flash; e.g. `gemini-4-argon-medium`; an unavailable id fails the turn with the list of available ones), `GARTH_ANTIGRAVITY_HOME`, `GARTH_ANTIGRAVITY_BIN`.
- Codex settings: `GARTH_CODEX_MODEL` (default: your Codex config's), `GARTH_CODEX_EFFORT` (default `medium`, quick enough for voice), `GARTH_CODEX_SANDBOX` (`read-only`, `workspace-write` (default) or `danger-full-access`), `GARTH_CODEX_BIN`, `GARTH_CODEX_ARGS`.

## Harness notes

- **claude**: runs `claude -p … --output-format stream-json`. Default permission mode is `acceptEdits`; set `CLAUDE_ARGS="--permission-mode bypassPermissions"` on a trusted box for fully autonomous runs. Follow-ups resume the session.
- **codex**: `codex exec --json …` (event mapping is best-effort; verify against your Codex version).
- **shell**: the instruction is the command.
- **cloud lane**: data model and adapter hooks exist; concrete cloud adapters are milestone M3.
