import { useEffect, useMemo, useRef, useState } from "react";
import { post, useStore } from "../store";

/** The one persistent control: a command line to G.A.R.T.H., its latest words, and anything that needs you. */
export function Command() {
  const state = useStore((s) => s.state);
  const streaming = useStore((s) => s.streaming);
  const select = useStore((s) => s.select);
  const [text, setText] = useState("");
  const [panel, setPanel] = useState<null | "history" | "inbox">(null);
  const input = useRef<HTMLInputElement>(null);

  const notes = state?.notifications;
  const transcript = state?.garth.transcript;
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
    post("/api/garth", { text: t }).catch((e) => alert(e.message));
  };
  const toggleInbox = () => {
    setPanel((p) => (p === "inbox" ? null : "inbox"));
    for (const n of notes ?? []) if (!n.read && !n.decision) post(`/api/notifications/${n.id}/read`);
  };

  return (
    <div className="command">
      {panel === "history" && (
        <div className="sheet">
          {(transcript ?? []).length === 0 && <div className="sheet-empty">No transmissions yet.</div>}
          {(transcript ?? []).map((m) => (
            <div key={m.id} className={`line ${m.role}`}>
              <span className="who">{m.role === "garth" ? "G.A.R.T.H." : m.role === "user" ? "YOU" : "SYS"}</span>
              <span className="what">{m.text}</span>
            </div>
          ))}
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

      {caption && !panel && !decision && (
        <div className={`caption ${streaming ? "live" : ""}`} onClick={() => setPanel("history")} title="Show transcript">
          {caption}
        </div>
      )}

      <div className="bar">
        <button className="sigil" onClick={() => setPanel((p) => (p === "history" ? null : "history"))} title="Transcript">◆</button>
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
        <button className={`badge ${unread ? "hot" : ""}`} onClick={toggleInbox} title="Inbox">
          {unread || "◇"}
        </button>
      </div>
    </div>
  );
}
