# Suggestions — what makes a system like this great to live in

Ranked roughly by value-for-effort. Items marked ★ are the ones I would do first after M1.

## Operator experience
- ★ **Push notifications off-device** — Pushover / ntfy / iMessage / Telegram when a task finishes or a decision is waiting, so you can leave the dashboard. G.A.R.T.H. already has `notify_user`; this is a second sink.
- ★ **Voice in / voice out for G.A.R.T.H.** — push-to-talk via the Web Speech API (or Whisper) and TTS for short replies. The Jarvis fantasy is mostly about not typing.
- ★ **Decision cards with context** — when G.A.R.T.H. asks you to choose, show the diff / file / command the decision is about inline, not just the options.
- **Approval gates by policy** — "anything that touches `prod`, deletes files, or costs > $X needs a tap". Lets you run agents in bypass-permissions mode safely.
- **Daily digest** — G.A.R.T.H. summarises what the fleet did while you were away, with a "what needs you" section at the top.
- **Keyboard-first command palette** (⌘K) — dispatch, jump to outpost, cancel task, answer decision without the mouse.
- **Mobile layout** — the inbox + G.A.R.T.H. chat alone, no graph, for phone use.
- **Time-travel scrubber** on the graph — replay the last hour of fleet activity.

## Agent & task management
- ★ **Task templates / playbooks** — "run tests and fix failures", "update deps and open PR", "deploy to staging". One click or one sentence to G.A.R.T.H.
- ★ **Project registry** — each outpost declares its repos (path, default harness, default permissions, branch policy). G.A.R.T.H. routes "fix the login bug" to the right machine and directory without you saying where.
- **Task dependencies / pipelines** — task B starts when A is done, with A's result in B's instruction. The data model only needs a `dependsOn` field.
- **Parallel fan-out with merge** — "try three approaches on three outposts, G.A.R.T.H. picks the best" (an eval-and-select pattern).
- **Budgets** — per-task / per-day token and dollar caps; the graph shows burn rate per node.
- **Resumable sessions** — every harness session id is kept so you can continue a finished Claude Code run from the UI ("one more thing…").
- **Scheduled / recurring tasks** — nightly dependency bumps, weekly test-health report, morning briefing.
- **Sub-agent visibility** — parse Claude Code's sub-agent events and render them as child nodes under the task.
- **Worktree per task** — outposts create a git worktree per task so parallel agents on the same repo don't collide; PR link shown on the node when done.

## Fleet & devices
- ★ **Outpost install one-liner** — `curl hq/install | sh` that drops the daemon in as a launchd / systemd service with the token baked in.
- **Device capabilities on the node** — GPU, free disk, battery, logged-in user, screen locked, so G.A.R.T.H. picks the right box for heavy work.
- **Wake-on-LAN / SSH fallback** — bring a sleeping outpost up before dispatching.
- **Outpost permission profiles** — allowed directories, denied commands, read-only mode. The protocol validates per op, so this is a filter in `ops.ts`.
- **File sync & diff viewer** — view a changed file on an outpost with before/after, apply or revert from HQ.
- **Secrets vault** — HQ holds API keys and hands them to outposts per task at run time, never on disk remotely.
- **Tailscale-native** — auto-discover outposts on the tailnet, mutual auth via node identity instead of a shared token.

## Cloud lane (M3)
- **Unified cloud session list** — Claude Code web sessions and Codex cloud tasks pulled in and shown in the violet ring, with "pull result to outpost" (apply the PR / branch locally).
- **Cloud ↔ local handoff** — start in the cloud, continue locally with the repo checked out, or the reverse.
- **Cost per lane** — show what the cloud lane costs vs. local compute.

## Trust, safety, auditability
- **Audit log** — every op (fs.write, exec, agent.run) with who/what/when, exportable. Half of this is the task event log already.
- **Kill switch** — one button that cancels every agent on every outpost.
- **Dry-run mode** — G.A.R.T.H. shows the plan (which tasks, where) and waits for a thumbs-up before dispatching.
- **Read-only share link** — let someone watch the graph without being able to dispatch.

## Nice to have
- Theme per outpost (colour-code machines), outpost nicknames and avatars.
- Sound design: a soft chime for results, a different one for decisions.
- Picture-in-picture G.A.R.T.H. orb that floats over other apps.
- Export a task's full transcript as Markdown.
