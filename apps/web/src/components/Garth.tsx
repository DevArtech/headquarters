import { useEffect, useRef, useState } from "react";
import { post, useStore } from "../store";

export function Garth() {
  const state = useStore((s) => s.state);
  const streaming = useStore((s) => s.streaming);
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const garth = state?.garth;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [garth?.transcript.length, streaming]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    await post("/api/garth", { text: t }).catch((e) => alert(e.message));
  };

  return (
    <>
      <div className="garth-head">
        <Orb state={garth?.state ?? "idle"} />
        <div className="garth-name">G.A.R.T.H.</div>
        <div className="garth-sub">General Agent for Routing, Tasking &amp; Handoffs · {garth?.state ?? "offline"}</div>
      </div>
      <div className="scroll">
        <div className="transcript">
          {garth?.transcript.length === 0 && !streaming && (
            <div className="empty">Tell me what needs doing. I will route it to the right outpost and come back with results.</div>
          )}
          {garth?.transcript.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.role !== "system" && <span className="who">{m.role === "garth" ? "G.A.R.T.H." : "you"}</span>}
              {m.text}
            </div>
          ))}
          {streaming && (
            <div className="msg garth"><span className="who">G.A.R.T.H.</span>{streaming}</div>
          )}
          <div ref={endRef} />
        </div>
      </div>
      <div className="composer">
        <textarea
          value={text}
          placeholder="Instruct G.A.R.T.H.…  (⌘⏎ to send)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && send()}
        />
        <button className="btn" onClick={send} disabled={!text.trim()}>Send</button>
      </div>
    </>
  );
}

function Orb({ state }: { state: string }) {
  return (
    <svg className="orb" viewBox="0 0 100 100" data-state={state}>
      <defs>
        <radialGradient id="coreGrad">
          <stop offset="0%" stopColor="#e9fbff" />
          <stop offset="35%" stopColor="#4fd1ff" />
          <stop offset="100%" stopColor="rgba(79,209,255,0)" />
        </radialGradient>
        <radialGradient id="alertGrad">
          <stop offset="0%" stopColor="#fff4e0" />
          <stop offset="35%" stopColor="#ffb547" />
          <stop offset="100%" stopColor="rgba(255,181,71,0)" />
        </radialGradient>
        <filter id="glow"><feGaussianBlur stdDeviation="1.5" /></filter>
      </defs>
      <circle className="pulse" cx="50" cy="50" r="40" />
      <circle className="ring c" cx="50" cy="50" r="46" />
      <circle className="ring a" cx="50" cy="50" r="38" />
      <circle className="ring b" cx="50" cy="50" r="30" />
      <circle className="core" cx="50" cy="50" r="20" />
    </svg>
  );
}
