/**
 * In-browser performance diagnostic. Open the UI with `?diag` and it measures, in *this* browser,
 * opening and scrolling the transcript, first as-is and then with each suspect effect disabled.
 * Results are posted to HQ (data/diag.jsonl). `?off=a,b` disables effects for manual comparison.
 */
const VARIANTS: Array<[string, string[]]> = [
  ["baseline", []],
  ["opaque-panel", ["opaque"]],
  ["no-clip-corners", ["clip"]],
  ["no-core", ["orb"]],
  ["no-edge-anim", ["edges"]],
  ["no-graph", ["graph"]],
  ["no-grain", ["grain"]],
  ["system-font", ["font"]],
  ["all-off", ["opaque", "clip", "orb", "edges", "graph", "grain", "font"]],
];
const ALL = ["opaque", "clip", "orb", "edges", "graph", "grain", "font"];

export function applyOff(list: string[]) {
  const root = document.documentElement;
  for (const k of ALL) root.classList.toggle(`off-${k}`, list.includes(k));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function record() {
  const f: number[] = [];
  let prev = performance.now();
  let on = true;
  const loop = (t: number) => {
    f.push(t - prev);
    prev = t;
    if (on) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return () => {
    on = false;
    const xs = f.slice(1).sort((a, b) => a - b);
    if (!xs.length) return null;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return { fps: Math.round(1000 / mean), p95: Math.round(xs[Math.floor(xs.length * 0.95)]), worst: Math.round(xs[xs.length - 1]), over25: xs.filter((x) => x > 25).length, frames: xs.length };
  };
}

function overlay() {
  const el = document.createElement("div");
  Object.assign(el.style, {
    position: "fixed", top: "14px", right: "14px", zIndex: "99", padding: "10px 14px", font: "12px ui-monospace, monospace",
    color: "#4fd1ff", background: "rgba(3,7,14,0.92)", border: "1px solid rgba(79,209,255,0.4)", letterSpacing: "0.08em",
  });
  document.body.appendChild(el);
  return el;
}

export async function runDiag() {
  const ui = overlay();
  ui.textContent = "Diagnostic: waiting for Headquarters…";
  for (let i = 0; i < 60 && !document.querySelector(".sigil"); i++) await sleep(250);
  await sleep(2000);
  const sigil = () => document.querySelector<HTMLButtonElement>(".sigil")!;
  const sheet = () => document.querySelector<HTMLDivElement>(".sheet");
  const results: Record<string, unknown> = {};

  for (let i = 0; i < VARIANTS.length; i++) {
    const [name, off] = VARIANTS[i];
    ui.textContent = `Diagnostic ${i + 1}/${VARIANTS.length}: ${name} — please don't touch the page`;
    applyOff(off);
    if (sheet()) sigil().click();
    await sleep(600);

    let stop = record();
    sigil().click(); // open the transcript
    await sleep(700);
    const open = stop();

    const el = sheet();
    stop = record();
    if (el) {
      // scroll up and down through the whole transcript over 2.4s
      const max = el.scrollHeight - el.clientHeight;
      const t0 = performance.now();
      await new Promise<void>((done) => {
        const step = (t: number) => {
          const p = (t - t0) / 2400;
          if (p >= 1) return done();
          el.scrollTop = max * (0.5 + 0.5 * Math.cos(p * Math.PI * 2));
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    }
    const scroll = stop();

    stop = record();
    await sleep(700);
    const openIdle = stop();
    results[name] = { open, scroll, openIdle, scrollable: el ? el.scrollHeight - el.clientHeight : 0 };
  }
  applyOff([]);
  if (sheet()) sigil().click();

  let renderer = "";
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    renderer = ext ? String(gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl?.getParameter(gl.RENDERER) ?? "no webgl");
  } catch {
    renderer = "unknown";
  }
  const report = {
    at: new Date().toISOString(),
    ua: navigator.userAgent,
    dpr: devicePixelRatio,
    viewport: [innerWidth, innerHeight],
    zoom: Math.round((outerWidth / innerWidth) * 100) / 100,
    renderer,
    messages: document.querySelectorAll(".line").length,
    results,
  };
  await fetch("/api/diag", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report) }).catch(() => {});
  ui.textContent = "Diagnostic done — results sent to Headquarters. You can close this tab.";
  console.table(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, JSON.stringify(v)])));
}
