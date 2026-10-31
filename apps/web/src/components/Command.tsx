import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GarthBrainKind, GarthMessage } from "@hq/protocol";
import { activeChannelOf, post, useStore } from "../store";
import { tts } from "../tts";

/** The one persistent control: a command line to G.A.R.T.H., its latest words, and anything that needs you. */
export function Command() {
  const state = useStore((s) => s.state);
  const streaming = useStore((s) => s.streaming);
  const select = useStore((s) => s.select);
  const activity = useStore((s) => s.activity);
  const voiceOn = useStore((s) => s.voiceOn);
  const setVoice = useStore((s) => s.setVoice);
  const channel = useStore(activeChannelOf);
  const setChannel = useStore((s) => s.setChannel);
  const channels = state?.garth.channels ?? [];
  const brains = state?.garth.brains ?? [];
  const [text, setText] = useState("");
  const [panel, setPanel] = useState<null | "history" | "inbox" | "channels">(null);
  const input = useRef<HTMLInputElement>(null);

  const notes = state?.notifications;
  const transcript = channel?.transcript;
  const decision = useMemo(() => [...(notes ?? [])].reverse().find((n) => n.decision && !n.decision.answer), [notes]);
  const unread = (notes ?? []).filter((n) => !n.read && !n.decision).length;
  const lastLine = useMemo(() => [...(transcript ?? [])].reverse().find((m) => m.role !== "user"), [transcript]);
  const caption = streaming || lastLine?.text || "";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName ?? "");
      if (e.key === "/" && !typing) {
        e.preventDefault();
        input.current?.focus();
      } else if (e.key === "Escape") {
        tts.stop();
        setPanel(null);
        select(null);
        input.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    setPanel(null);
    post("/api/garth", { text: t, channelId: channel?.id }).catch((e) => alert(e.message));
  };
  const switchTo = (id: string) => {
    setChannel(id);
    setPanel(null);
    input.current?.focus();
  };
  const newChannel = () =>
    post("/api/channels", {})
      .then((c: { id: string }) => switchTo(c.id))
      .catch((e) => alert(e.message));
  const toggleInbox = () => {
    setPanel((p) => (p === "inbox" ? null : "inbox"));
    for (const n of notes ?? []) if (!n.read && !n.decision) post(`/api/notifications/${n.id}/read`);
  };

  return (
    <div className="command">
      {panel === "history" && <History transcript={transcript ?? []} />}
      {panel === "channels" && (
        <div className="sheet">
          <button className="new-channel" onClick={newChannel}>+ New channel</button>
          {channels.map((c) => {
            const last = [...c.transcript].reverse().find((m) => m.role !== "system");
            return (
              <div key={c.id} className={`chan ${c.id === channel?.id ? "on" : ""}`} onClick={() => switchTo(c.id)}>
                <div className="chan-head">
                  <span className="chan-name"># {c.name}</span>
                  <span className="chan-brain">{BRAIN[c.brain]}</span>
                  {c.state !== "idle" && <i className="led running" />}
                  <span className="time">{ago(c.updatedAt)}</span>
                  {c.id !== "general" && (
                    <button
                      className="chan-del"
                      title="Delete channel"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!confirm(`Delete "${c.name}" and its history?`)) return;
                        fetch(`/api/channels/${c.id}`, { method: "DELETE" }).then(() => c.id === channel?.id && setChannel("general"));
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
                {last && <div className="chan-last">{last.role === "user" ? "You: " : ""}{last.text}</div>}
              </div>
            );
          })}
        </div>
      )}
      {panel === "inbox" && (
        <div className="sheet">
          {(notes ?? []).length === 0 && <div className="sheet-empty">Nothing needs you.</div>}
          {(notes ?? []).map((n) => (
            <div
              key={n.id}
              className={`note ${n.level}`}
              onClick={() => n.taskId && (select({ kind: "task", id: n.taskId }), setPanel(null))}
            >
              <span className="time">{new Date(n.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              <div className="t">{n.title}</div>
              {n.body && <div className="b">{n.body}</div>}
              {n.decision?.answer && <div className="b">→ {n.decision.answer}</div>}
            </div>
          ))}
        </div>
      )}

      {decision && (
        <div className="decision">
          <div className="decision-tag">Decision required</div>
          <div className="decision-q">{decision.decision!.question}</div>
          <div className="decision-opts">
            {decision.decision!.options.map((o) => (
              <button key={o} onClick={() => post(`/api/notifications/${decision.id}/answer`, { answer: o })}>{o}</button>
            ))}
          </div>
        </div>
      )}

      {activity && !panel && !decision && <div className="activity">{activity}</div>}
      {caption && !panel && !decision && (
        <div className={`caption ${streaming ? "live" : ""}`} onClick={() => setPanel("history")} title="Show transcript">
          {caption}
        </div>
      )}

      <div className="bar">
        <button className="sigil" onClick={() => setPanel((p) => (p === "history" ? null : "history"))} title="Transcript">◆</button>
        <button className="chan-chip" onClick={() => setPanel((p) => (p === "channels" ? null : "channels"))} title="Channels">
          # {channel?.name ?? "General"}
        </button>
        {channel && (
          <select
            className="brain-chip"
            value={channel.brain}
            disabled={brains.length < 2}
            title={`G.A.R.T.H. in this channel runs on ${BRAIN[channel.brain]}${channel.model ? ` (${channel.model})` : ""}`}
            onChange={(e) => post(`/api/channels/${channel.id}/brain`, { kind: e.target.value }).catch((err) => alert(err.message))}
          >
            {brains.map((b) => (
              <option key={b} value={b}>{BRAIN[b]}</option>
            ))}
          </select>
        )}
        <input
          id="garth-input"
          ref={input}
          value={text}
          autoComplete="off"
          spellCheck={false}
          placeholder="Speak to G.A.R.T.H."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <kbd>/</kbd>
        {tts.available && (
          <button className={`voice ${voiceOn ? "on" : ""}`} onClick={() => setVoice(!voiceOn)} title={voiceOn ? "Mute G.A.R.T.H. (Esc stops speech)" : "Unmute G.A.R.T.H."}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
              {voiceOn ? (
                <path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              ) : (
                <path d="M16.5 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              )}
            </svg>
          </button>
        )}
        <button className={`badge ${unread ? "hot" : ""}`} onClick={toggleInbox} title="Inbox">
          {unread || "◇"}
        </button>
      </div>
    </div>
  );
}

/**
 * Transcript sheet. Opens scrolled to the latest message and stays pinned to the bottom as new text
 * arrives, unless the operator has scrolled up to read. G.A.R.T.H.'s in-progress reply is shown as a
 * live last line.
 */
function History({ transcript }: { transcript: GarthMessage[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const streaming = useStore((s) => s.streaming);
  // before paint, so the sheet never flashes at the top
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [transcript.length, streaming]);
  return (
    <div
      className="sheet"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {transcript.length === 0 && !streaming && <div className="sheet-empty">No transmissions yet.</div>}
      <Lines transcript={transcript} />
      {streaming && (
        <div className="line garth live">
          <span className="who">G.A.R.T.H.</span>
          <span className="what">{streaming}</span>
        </div>
      )}
    </div>
  );
}

/** Re-renders only when a message is added, not on every snapshot or streamed token. */
const Lines = memo(
  function Lines({ transcript }: { transcript: GarthMessage[] }) {
    return (
      <>
        {transcript.map((m) => (
          <div key={m.id} className={`line ${m.role}`}>
            <span className="who">{m.role === "garth" ? "G.A.R.T.H." : m.role === "user" ? "YOU" : "SYS"}</span>
            <span className="what">{m.text}</span>
          </div>
        ))}
      </>
    );
  },
  (a, b) => a.transcript.length === b.transcript.length && a.transcript[a.transcript.length - 1]?.id === b.transcript[b.transcript.length - 1]?.id,
);

const BRAIN: Record<GarthBrainKind, string> = { "claude-code": "Claude Code", codex: "Codex", api: "Claude API" };

function ago(ts: number) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
