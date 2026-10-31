import { useEffect, useRef } from "react";

type RGB = [number, number, number];
const TAU = Math.PI * 2;

/** Per-state targets. The orb eases between them so state changes feel like a living system. */
const MODES: Record<string, { c: RGB; c2: RGB; energy: number; speed: number; jitter: number }> = {
  idle: { c: [79, 209, 255], c2: [46, 230, 197], energy: 0.22, speed: 1, jitter: 0.15 },
  thinking: { c: [155, 123, 255], c2: [79, 209, 255], energy: 0.55, speed: 3.4, jitter: 1 },
  speaking: { c: [46, 230, 197], c2: [140, 240, 255], energy: 1, speed: 1.7, jitter: 0.35 },
  alert: { c: [255, 181, 71], c2: [255, 92, 122], energy: 0.7, speed: 1.3, jitter: 0.4 },
};

const LEGEND = " G.A.R.T.H. ◆ GENERAL AGENT FOR ROUTING · TASKING · HANDOFFS ◆ HEADQUARTERS CORE ◆ ";

/**
 * G.A.R.T.H. core: a canvas HUD with ~12 layers (ticks, legend ring, segmented arcs,
 * voice waveform, scanner sweep, orbiting particles, sacred-geometry inner frame, plasma core).
 */
export function Orb({ state, size = 340 }: { state: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef(state);
  live.current = state;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const px = Math.min(3, (window.devicePixelRatio || 1) * 1.5);
    canvas.width = size * px;
    canvas.height = size * px;
    const R = size / 2;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.25 : 1;

    const cur = { c: [...MODES.idle.c] as RGB, c2: [...MODES.idle.c2] as RGB, energy: 0.22, speed: 1, jitter: 0.15 };
    const rot = { a: 0, b: 0, c: 0, d: 0, scan: 0 };
    const particles = Array.from({ length: 80 }, () => ({
      r: 0.4 + Math.random() * 0.52,
      a: Math.random() * TAU,
      v: (0.12 + Math.random() * 0.55) * (Math.random() < 0.5 ? -1 : 1),
      s: 0.4 + Math.random() * 1.2,
      ph: Math.random() * TAU,
    }));
    const ripples: number[] = [];
    let lastRipple = 0;
    let last = performance.now();
    let raf = 0;

    // pre-measure legend glyphs once
    const fontPx = R * 0.042;
    ctx.font = `600 ${fontPx}px "JetBrains Mono", ui-monospace, monospace`;
    const glyphs = [...LEGEND.repeat(2)].map((ch) => ({ ch, w: ctx.measureText(ch).width + fontPx * 0.22 }));

    const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a))})`;
    const ring = (r: number) => {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.stroke();
    };
    const arcs = (r: number, rotA: number, segs: Array<[number, number]>, w: number, a: number, col: RGB) => {
      ctx.lineWidth = w;
      ctx.strokeStyle = rgba(col, a);
      for (const [s, e] of segs) {
        ctx.beginPath();
        ctx.arc(0, 0, r, s + rotA, e + rotA);
        ctx.stroke();
      }
    };
    const poly = (n: number, r: number, rotA: number) => {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const a = rotA + (i / n) * TAU;
        i ? ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r) : ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.stroke();
    };

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000) * reduce;
      last = now;
      const t = now / 1000;
      const m = MODES[live.current] ?? MODES.idle;
      const k = 1 - Math.pow(0.03, dt);
      for (let i = 0; i < 3; i++) {
        cur.c[i] += (m.c[i] - cur.c[i]) * k;
        cur.c2[i] += (m.c2[i] - cur.c2[i]) * k;
      }
      cur.energy += (m.energy - cur.energy) * k;
      cur.speed += (m.speed - cur.speed) * k;
      cur.jitter += (m.jitter - cur.jitter) * k;
      const { energy: e, speed: sp, jitter: jt, c, c2 } = cur;
      rot.a += dt * 0.04 * sp;
      rot.b -= dt * 0.09 * sp;
      rot.c += dt * 0.32 * sp;
      rot.d -= dt * 0.55 * sp;
      rot.scan += dt * (0.7 + sp * 0.9);

      ctx.setTransform(px, 0, 0, px, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.translate(R, R);
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";

      // 1 · ambient bloom
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
      g.addColorStop(0, rgba(c, 0.2 + 0.2 * e));
      g.addColorStop(0.3, rgba(c, 0.06 + 0.06 * e));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, TAU);
      ctx.fill();

      // 2 · ripples emitted from the core
      if (t - lastRipple > 2.8 / sp) (ripples.push(t), (lastRipple = t));
      while (ripples.length && t - ripples[0] > 2.4) ripples.shift();
      ctx.lineWidth = 1;
      for (const r0 of ripples) {
        const q = (t - r0) / 2.4;
        ctx.strokeStyle = rgba(c, 0.32 * (1 - q) * (1 - q));
        ring(R * (0.24 + q * 0.74));
      }

      // 3 · scanner sweep
      if ("createConicGradient" in ctx) {
        const cg = ctx.createConicGradient(rot.scan, 0, 0);
        cg.addColorStop(0, rgba(c2, 0));
        cg.addColorStop(0.86, rgba(c2, 0));
        cg.addColorStop(0.995, rgba(c2, 0.1 + 0.22 * jt));
        cg.addColorStop(1, rgba(c2, 0));
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.84, 0, TAU);
        ctx.arc(0, 0, R * 0.32, 0, TAU, true);
        ctx.fill();
      }

      // 4 · outer bezel ticks (graduated like an instrument dial)
      ctx.save();
      ctx.rotate(rot.a);
      for (let i = 0; i < 180; i++) {
        const major = i % 15 === 0;
        const mid = i % 5 === 0;
        const r1 = R * 0.975;
        const len = major ? R * 0.06 : mid ? R * 0.035 : R * 0.016;
        const a = (i / 180) * TAU;
        ctx.strokeStyle = rgba(c, major ? 0.85 : mid ? 0.42 : 0.2);
        ctx.lineWidth = major ? 1.4 : 0.7;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
        ctx.lineTo(Math.cos(a) * (r1 - len), Math.sin(a) * (r1 - len));
        ctx.stroke();
      }
      // bezel index markers
      ctx.fillStyle = rgba(c2, 0.9);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU;
        ctx.save();
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(R * 0.995, 0);
        ctx.lineTo(R * 0.95, -R * 0.018);
        ctx.lineTo(R * 0.95, R * 0.018);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();

      // 5 · legend ring (counter-rotating text)
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.rotate(rot.b);
      ctx.font = `600 ${fontPx}px "JetBrains Mono", ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = rgba(c, 0.55);
      const rText = R * 0.865;
      let ang = 0;
      for (const { ch, w } of glyphs) {
        ang += w / 2 / rText;
        if (ang > TAU - 0.02) break;
        ctx.save();
        ctx.rotate(ang);
        ctx.translate(0, -rText);
        ctx.fillText(ch, 0, 0);
        ctx.restore();
        ang += w / 2 / rText;
      }
      ctx.restore();

      // 6 · segmented arc stack
      ctx.shadowBlur = 10;
      ctx.shadowColor = rgba(c, 0.8);
      arcs(R * 0.8, rot.c * 0.45, [[0, 0.95], [1.25, 1.55], [2.1, 3.35], [3.85, 4.05], [4.5, 5.85]], 2.2, 0.65, c);
      ctx.shadowBlur = 0;
      ctx.setLineDash([1.5, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(c, 0.4);
      ctx.save();
      ctx.rotate(rot.b * 1.6);
      ring(R * 0.765);
      ctx.restore();
      ctx.setLineDash([]);
      ctx.shadowBlur = 14;
      ctx.shadowColor = rgba(c2, 0.9);
      arcs(R * 0.725, rot.d * 0.6, [[0, 1.05], [Math.PI, Math.PI + 1.05]], 3.5, 0.55 + 0.3 * e, c2);
      ctx.shadowBlur = 0;
      arcs(R * 0.69, -rot.c * 0.8, [[0.3, 0.42], [1.9, 2.02], [3.5, 3.62], [5.1, 5.22]], 5, 0.7, c);
      ctx.strokeStyle = rgba(c, 0.16);
      ctx.lineWidth = 0.8;
      ring(R * 0.665);

      // 7 · voice waveform ring
      const N = 128;
      const env = 0.55 + 0.45 * Math.sin(t * 6.3) * Math.sin(t * 2.1 + 1);
      const inner = R * 0.5;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * TAU;
        const n = Math.sin(i * 0.47 + t * 3.1) * Math.sin(i * 0.11 - t * 1.6) + 0.5 * Math.sin(i * 1.3 + t * 7);
        let amp = (0.12 + e * 0.88) * (0.3 + 0.7 * Math.abs(n)) * (e > 0.8 ? env : 1);
        amp += jt * 0.25 * Math.random();
        let d = Math.abs(((a - rot.scan) % TAU + TAU) % TAU);
        d = Math.min(d, TAU - d);
        const hl = Math.max(0, 1 - d / 0.55);
        const len = R * (0.012 + amp * 0.1 + hl * 0.05 * jt);
        ctx.strokeStyle = rgba(hl > 0.05 ? c2 : c, 0.3 + 0.5 * hl + 0.25 * e);
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
        ctx.lineTo(Math.cos(a) * (inner + len), Math.sin(a) * (inner + len));
        ctx.stroke();
      }

      // 8 · orbiting particles with trails
      for (const p of particles) {
        p.a += p.v * dt * sp * 0.55;
        const r = R * p.r;
        const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 2.5 + p.ph));
        ctx.strokeStyle = rgba(c, 0.18 * tw);
        ctx.lineWidth = p.s * 0.8;
        ctx.beginPath();
        ctx.arc(0, 0, r, p.a - p.v * 0.22, p.a, p.v < 0);
        ctx.stroke();
        ctx.fillStyle = rgba(p.r > 0.7 ? c2 : c, 0.75 * tw);
        ctx.beginPath();
        ctx.arc(Math.cos(p.a) * r, Math.sin(p.a) * r, p.s, 0, TAU);
        ctx.fill();
      }

      // 9 · inner frame: hexagon, hexagram, crosshair, dotted ring
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(c, 0.5);
      poly(6, R * 0.4, rot.d * 0.25);
      ctx.strokeStyle = rgba(c2, 0.35);
      poly(3, R * 0.33, -rot.c * 0.5);
      poly(3, R * 0.33, -rot.c * 0.5 + Math.PI);
      ctx.strokeStyle = rgba(c, 0.55);
      for (let i = 0; i < 4; i++) {
        const a = rot.a * 2 + (i / 4) * TAU + Math.PI / 4;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * R * 0.36, Math.sin(a) * R * 0.36);
        ctx.lineTo(Math.cos(a) * R * 0.46, Math.sin(a) * R * 0.46);
        ctx.stroke();
      }
      ctx.fillStyle = rgba(c, 0.6);
      for (let i = 0; i < 48; i++) {
        const a = rot.c + (i / 48) * TAU;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * R * 0.27, Math.sin(a) * R * 0.27, i % 4 === 0 ? 1.1 : 0.55, 0, TAU);
        ctx.fill();
      }

      // 10 · plasma core
      const pulse = 1 + Math.sin(t * 2.2) * 0.04 + (e > 0.8 ? 0.09 * env : 0) + jt * 0.02 * Math.sin(t * 17);
      const cr = R * 0.22 * pulse;
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, cr);
      core.addColorStop(0, "rgba(255,255,255,0.95)");
      core.addColorStop(0.22, rgba([(c2[0] + 255) / 2, (c2[1] + 255) / 2, (c2[2] + 255) / 2], 0.85));
      core.addColorStop(0.55, rgba(c, 0.45));
      core.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(0, 0, cr, 0, TAU);
      ctx.fill();
      ctx.lineWidth = 1.2;
      for (let i = 0; i < 3; i++) {
        ctx.strokeStyle = `rgba(255,255,255,${0.35 - i * 0.08})`;
        ctx.beginPath();
        const rr = R * (0.07 + i * 0.03);
        const s = rot.d * (1.4 - i * 0.3) + i * 2;
        ctx.arc(0, 0, rr, s, s + 1.6 + i * 0.4);
        ctx.stroke();
      }

      // 11 · alert halo
      if (cur.c[0] > 200) {
        ctx.strokeStyle = rgba(c, 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(t * 6)));
        ctx.lineWidth = 2;
        ring(R * 0.99);
      }

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return <canvas ref={ref} className="orb" style={{ width: size, height: size }} />;
}
