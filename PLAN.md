# Headquarters — Implementation Plan

> A command center for agents across devices. One **Headquarters** (HQ) runs the brain and the UI;
> every other machine runs an **Outpost**. The user talks to **G.A.R.T.H.**, who distributes work,
> watches it, and comes back only when there is a result or a decision to make.

**G.A.R.T.H.** = **G**eneral **A**gent for **R**outing, **T**asking & **H**andoffs.

---

## 1. Core concepts

| Concept | What it is |
|---|---|
| **Headquarters (HQ)** | The primary server. Owns state, runs G.A.R.T.H., serves the web UI, accepts Outpost connections. Also runs an embedded local Outpost so the HQ machine is itself a worksite. |
| **Outpost** | A small daemon on any device. Dials *out* to HQ over WebSocket (NAT-friendly), authenticates with a shared token, then executes requests: file ops, shell exec, and launching/controlling agent harnesses. |
| **Harness** | An agent runtime installed on an Outpost: Claude Code, Codex, or a plain shell. Each has an adapter that knows how to start a run, stream its events, send it a follow-up message, and cancel it. |
| **Lane** | Where an agent run executes: `local` (a process on the Outpost) or `cloud` (a remote session the harness manages, e.g. Claude Code web sessions / Codex cloud). Cloud runs are *tracked through* an Outpost but are rendered separately in the graph. |
| **Task** | A unit of work: an instruction, a target (outpost + harness + lane), a status, a stream of events, and a result. Tasks are created by the user or by G.A.R.T.H. |
| **Agent** | A live run of a task on a harness. One task → one agent (plus any sub-agents the harness reports). |
| **Notification / Decision** | What G.A.R.T.H. raises for the user: an informational result, or a decision with explicit options that blocks a task until answered. |

## 2. Architecture

```
┌──────────────── Web UI (browser) ────────────────┐
│  React + React Flow node graph · G.A.R.T.H. orb  │
│  REST for commands · WS /ws/ui for live state    │
└───────────────────────┬──────────────────────────┘
                        │
┌───────────────── Headquarters (Node) ────────────┐
│  api.ts      HTTP + UI WebSocket (Hono + ws)      │
│  fleet.ts    Outpost registry + request/response  │
│  tasks.ts    Task lifecycle, event log, routing   │
│  garth.ts    G.A.R.T.H. agent (Claude API, tools) │
│  store.ts    Persistence (JSON file; swappable)   │
│  embedded local Outpost                           │
└───────────────────────┬──────────────────────────┘
                        │ WS /ws/outpost  (token auth)
        ┌───────────────┼───────────────┐
   ┌────▼────┐     ┌────▼────┐     ┌────▼────┐
   │ Outpost │     │ Outpost │     │ Outpost │
   │ ops.ts  │     │ (laptop)│     │ (server)│
   │ harness/│     └─────────┘     └─────────┘
   │  claude │─── local process (claude -p --output-format stream-json)
   │  codex  │─── local process (codex exec --json)
   │  shell  │─── plain command
   │  cloud  │─── tracks remote sessions, reports them as lane=cloud
   └─────────┘
```

**Transport**: one typed JSON protocol (`packages/protocol`) shared by all three apps, validated at the boundary with zod. Outposts never accept inbound connections.

**State model**: HQ holds the whole world in memory and broadcasts a full snapshot to the UI on every change. The snapshot is small (dozens of nodes), so there is no diffing, no client cache, and no sync bugs. Persistence is a single JSON file written on change; swap for SQLite when the event log grows.

## 3. Tech stack (and why it is the minimal one)

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript everywhere, ESM, Node 22 | One language, one toolchain, shared types across HQ/Outpost/UI. |
| Monorepo | pnpm workspaces | Three apps + one shared package, no extra build orchestration. |
| HQ server | Hono + `@hono/node-server` + `ws` | Tiny, typed, fast. Serves the built UI as static files in production. |
| Outpost | plain Node + `ws` client | Zero framework. Dials out, reconnects with backoff, executes ops. |
| G.A.R.T.H. brain | `@anthropic-ai/sdk`, Claude Opus 5.5, manual tool loop | Tool loop is ~60 lines and we need to persist the conversation and stream events to the UI; the SDK's beta tool runner adds nothing here. Server-side refusal fallbacks enabled by default. |
| Validation | zod | Protocol frames and tool inputs validated once at the boundary. |
| Persistence | JSON file (`data/hq.json`) | v0. Interface is 4 functions; SQLite drop-in later. |
| UI | Vite + React 18 + `@xyflow/react` + zustand | React Flow is the standard node-graph library; zustand is a 1 KB store. No UI kit: hand-written CSS with design tokens so the look is ours. |
| Dev runtime | `tsx` | Run TS directly, no build step for servers. `tsc --noEmit` for typechecks. |
| Auth | Shared bearer token (`HQ_TOKEN`) for Outposts; UI is localhost-only in v0 | Put HQ behind Tailscale for multi-device; see SUGGESTIONS.md for proper auth. |

## 4. Protocol (packages/protocol)

Outpost → HQ: `hello`, `heartbeat`, `res` (reply to a request), `event` (agent stream events), `agents` (full list of live agents on this outpost, local + cloud).
HQ → Outpost: `req` with an `op`: `fs.list`, `fs.read`, `fs.write`, `exec`, `agent.run`, `agent.send`, `agent.cancel`, `cloud.list`.
UI ↔ HQ: REST (`/api/*`) for commands, WS `/ws/ui` pushes `{type:"snapshot", state}` and `{type:"garth", ...}` stream chunks.

## 5. Milestones

- **M0 — Scaffold (this commit)**: monorepo, protocol, HQ with fleet/tasks/GARTH/API, Outpost with adapters, web UI with graph + orb + inbox + command bar. Everything typechecks and the UI builds.
- **M1 — First light**: `pnpm dev` boots HQ + embedded Outpost + UI. The graph shows HQ, the local Outpost, its harnesses. Typing an instruction to G.A.R.T.H. dispatches a Claude Code task on the local Outpost; events stream into the task node; a notification lands in the Inbox when it finishes.
- **M2 — Second device**: run `pnpm outpost` on another machine with `HQ_URL`/`HQ_TOKEN`; it appears on the graph. File browser panel for an Outpost (list/read/write). Decisions (`request_decision`) block a task until the user picks an option in the Inbox.
- **M3 — Cloud lane**: concrete cloud adapters. Claude Code web sessions and Codex cloud tasks are listed/tracked per Outpost and rendered in a separate cloud ring around that Outpost. *(Needs verification of each harness's remote-session CLI/API surface; the adapter interface is in place now.)*
- **M4 — Hardening**: SQLite store, per-outpost permission policy (allowed dirs, allowed commands), UI auth, TLS/Tailscale docs, reconnect/resume of in-flight agent runs.

## 6. Project layout

```
headquarters/
  PLAN.md  SUGGESTIONS.md  README.md
  packages/protocol/      shared message + model types (zod)
  apps/hq/                Headquarters server + G.A.R.T.H.
  apps/outpost/           Outpost daemon + harness adapters
  apps/web/               Node-graph web UI
```
