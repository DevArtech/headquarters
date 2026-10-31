import { useEffect, useRef, useState } from "react";
import { BRAIN_NAME, type Settings as SettingsT } from "@hq/protocol";
import { post, useStore } from "../store";

interface Voice {
  id: string;
  name: string;
  accent: string;
  gender: string;
  grade: string;
}

/**
 * Settings: the defaults for new channels and page loads. Changes apply immediately; G.A.R.T.H. can
 * change the same settings when asked, and this panel follows along.
 */
export function SettingsPanel() {
  const settings = useStore((s) => s.state?.settings);
  const brains = useStore((s) => s.state?.garth.brains ?? []);
  const channels = useStore((s) => s.state?.garth.channels ?? []);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [error, setError] = useState("");
  const [model, setModel] = useState(settings?.model ?? "");
  const [speed, setSpeed] = useState(settings?.voiceSpeed ?? 1.05);
  const speedTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    fetch("/api/voices").then((r) => r.json()).then((v) => Array.isArray(v) && setVoices(v)).catch(() => {});
  }, []);
  // follow changes made elsewhere (e.g. by G.A.R.T.H.)
  useEffect(() => setModel(settings?.model ?? ""), [settings?.model]);
  useEffect(() => setSpeed(settings?.voiceSpeed ?? 1.05), [settings?.voiceSpeed]);

  if (!settings) return null;
  const save = (patch: Partial<Record<keyof SettingsT, unknown>>) => {
    setError("");
    post("/api/settings", patch).catch((e) => setError(e.message));
  };
  const preferred = brains[0];
  const fixedChannel = !["last", "general", "new"].includes(settings.startupChannel);

  return (
    <div className="settings">
      <div className="h">Settings</div>
      <p className="hint">Defaults for new channels and when this page loads. You can also just ask G.A.R.T.H. to change any of these.</p>

      <section>
        <div className="sec">New channels</div>
        <label>
          <span>Brain</span>
          <select value={settings.brain ?? ""} onChange={(e) => save({ brain: e.target.value || null })}>
            <option value="">Automatic{preferred ? ` (${BRAIN_NAME[preferred]})` : ""}</option>
            {brains.map((b) => (
              <option key={b} value={b}>{BRAIN_NAME[b]}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Model</span>
          <input
            value={model}
            placeholder="harness default"
            spellCheck={false}
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => model !== (settings.model ?? "") && save({ model: model.trim() || null })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </label>
        <p className="note">Existing channels keep their brain. To switch the current one, ask G.A.R.T.H.</p>
      </section>

      <section>
        <div className="sec">On page load</div>
        <label>
          <span>Open channel</span>
          <select value={settings.startupChannel} onChange={(e) => save({ startupChannel: e.target.value })}>
            <option value="last">Last used</option>
            <option value="general">General</option>
            <option value="new">A new channel</option>
            {channels
              .filter((c) => c.id !== "general")
              .map((c) => (
                <option key={c.id} value={c.id}># {c.name}</option>
              ))}
            {fixedChannel && !channels.some((c) => c.id === settings.startupChannel) && <option value={settings.startupChannel}>(deleted channel)</option>}
          </select>
        </label>
        <label className="row">
          <span>Voice on</span>
          <input type="checkbox" checked={settings.voiceOn} onChange={(e) => save({ voiceOn: e.target.checked })} />
        </label>
      </section>

      <section>
        <div className="sec">Voice</div>
        <label>
          <span>Voice</span>
          <select value={settings.voice ?? ""} onChange={(e) => save({ voice: e.target.value || null })}>
            <option value="">Default</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} · {v.accent} {v.gender.toLowerCase()} · {v.grade}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Speed {speed.toFixed(2)}×</span>
          <input
            type="range"
            min={0.7}
            max={1.5}
            step={0.05}
            value={speed}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSpeed(v);
              clearTimeout(speedTimer.current);
              speedTimer.current = setTimeout(() => save({ voiceSpeed: v }), 350);
            }}
          />
        </label>
        <button className="btn" onClick={() => preview(settings.voice)}>Test voice</button>
      </section>

      {error && <p className="err">{error}</p>}
    </div>
  );
}

async function preview(voice?: string) {
  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Good evening. All systems are standing by.", ...(voice ? { voice } : {}) }),
  });
  if (!r.ok) return;
  const url = URL.createObjectURL(await r.blob());
  const a = new Audio(url);
  a.onended = () => URL.revokeObjectURL(url);
  a.play().catch(() => {});
}
