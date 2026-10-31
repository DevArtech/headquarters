# Headquarters

Command center for agent harnesses (Claude Code, Codex, shell) across your devices.
Talk to **G.A.R.T.H.** (General Agent for Routing, Tasking & Handoffs); it distributes work to Outposts and comes back with results and decisions.

See [PLAN.md](PLAN.md) for architecture and milestones, [SUGGESTIONS.md](SUGGESTIONS.md) for the feature wishlist.

## Run it

```bash
cp .env.example .env     # set HQ_TOKEN and ANTHROPIC_API_KEY
pnpm install
pnpm dev                 # HQ on :4800 (with embedded local Outpost) + Vite UI on :5180
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

## Harness notes

- **claude**: runs `claude -p … --output-format stream-json`. Default permission mode is `acceptEdits`; set `CLAUDE_ARGS="--permission-mode bypassPermissions"` on a trusted box for fully autonomous runs. Follow-ups resume the session.
- **codex**: `codex exec --json …` (event mapping is best-effort; verify against your Codex version).
- **shell**: the instruction is the command.
- **cloud lane**: data model and adapter hooks exist; concrete cloud adapters are milestone M3.
