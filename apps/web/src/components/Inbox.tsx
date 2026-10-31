import { post, useStore } from "../store";

export function Inbox() {
  const notes = useStore((s) => s.state?.notifications) ?? [];
  const select = useStore((s) => s.select);
  if (notes.length === 0) return <div className="empty">Nothing needs you.</div>;
  return (
    <div className="inbox">
      {notes.map((n) => (
        <div
          key={n.id}
          className={`note ${n.level} ${n.read ? "" : "unread"}`}
          onClick={() => {
            if (!n.read && !n.decision) post(`/api/notifications/${n.id}/read`);
            if (n.taskId) select({ kind: "task", id: n.taskId });
          }}
        >
          <span className="time">{new Date(n.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <div className="t">{n.title}</div>
          {n.body && <div className="b">{n.body}</div>}
          {n.decision && !n.decision.answer && (
            <div className="opts" onClick={(e) => e.stopPropagation()}>
              {n.decision.options.map((o) => (
                <button key={o} className="btn" onClick={() => post(`/api/notifications/${n.id}/answer`, { answer: o })}>{o}</button>
              ))}
            </div>
          )}
          {n.decision?.answer && <div className="answered">→ {n.decision.answer}</div>}
        </div>
      ))}
    </div>
  );
}
