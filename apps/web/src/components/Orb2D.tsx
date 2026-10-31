import { memo, useEffect, useRef } from "react";

type RGB = [number, number, number];
type Ctx = CanvasRenderingContext2D;
const TAU = Math.PI * 2;

/** Per-state targets. The orb eases between them so state changes feel like a living system. */
const MODES: Record<string, { c: RGB; c2: RGB; energy: number; speed: number; jitter: number }> = {
  idle: { c: [79, 209, 255], c2: [46, 230, 197], energy: 0.22, speed: 1, jitter: 0.15 },
  thinking: { c: [155, 123, 255], c2: [79, 209, 255], energy: 0.55, speed: 3.4, jitter: 1 },
  speaking: { c: [46, 230, 197], c2: [140, 240, 255], energy: 1, speed: 1.7, jitter: 0.35 },
  alert: { c: [255, 181, 71], c2: [255, 92, 122], energy: 0.7, speed: 1.3, jitter: 0.4 },
};

const LEGEND = " G.A.R.T.H. ◆ GENERAL AGENT FOR ROUTING · TASKING · HANDOFFS ◆ HEADQUARTERS CORE ◆ ";
const FONT = (px: number) => `600 ${px}px "JetBrains Mono", ui-monospace, monospace`;
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a))})`;

const NAMES = ["bloom", "scan", "bezel", "legend", "arc80", "dash", "arc72", "arc69", "hex", "tri", "dots", "core"] as const;
type Name = (typeof NAMES)[number];

/**
 * G.A.R.T.H. core: a canvas HUD with ~12 layers, drawn into one canvas.
 *
 * Performance model: everything that only rotates (bezel, legend, arc stacks, geometry, glows,
 * gradients) is rasterised once per palette into an offscreen bitmap and stamped with drawImage
 * each frame. Only the waveform, particles, ripples and core swirl are drawn live, batched into a
 * handful of paths. A state change builds the next palette one layer per frame, then crossfades.
 */
export const Orb2D = memo(function Orb2D({ state, size = 340 }: { state: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef(state);
  live.current = state;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const px = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(size * px);
    canvas.width = W;
    canvas.height = W;
    const R = size / 2;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.25 : 1;

    // ── offscreen layer cache ──────────────────────────────────────────
    type Layer = { img: CanvasImageSource; extent: number };
    type Layers = Record<Name, Layer>;
    const canBitmap = typeof OffscreenCanvas !== "undefined" && "transferToImageBitmap" in OffscreenCanvas.prototype;
    /** extent: fraction of the orb radius the layer covers; res: resolution factor (soft gradients need little). */
    const layer = (draw: (g: Ctx) => void, extent = 1, res = 1): Layer => {
      const s = px * res;
      const side = Math.max(2, Math.ceil(size * extent * s));
      const cv: OffscreenCanvas | HTMLCanvasElement = canBitmap
        ? new OffscreenCanvas(side, side)
        : Object.assign(document.createElement("canvas"), { width: side, height: side });
      const g = cv.getContext("2d") as Ctx;
      g.setTransform(s, 0, 0, s, R * extent * s, R * extent * s);
      g.lineCap = "round";
      // additive, like the main canvas: a stroke adds to its own glow rather than covering it
      g.globalCompositeOperation = "lighter";
      draw(g);
      return { img: canBitmap ? (cv as OffscreenCanvas).transferToImageBitmap() : (cv as HTMLCanvasElement), extent };
    };
    const ring = (g: Ctx, r: number) => {
      g.beginPath();
      g.arc(0, 0, r, 0, TAU);
      g.stroke();
    };
    const arcs = (g: Ctx, r: number, segs: Array<[number, number]>, w: number, a: number, col: RGB) => {
      g.lineWidth = w;
      g.strokeStyle = rgba(col, a);
      g.beginPath();
      for (const [s, e] of segs) {
        g.moveTo(Math.cos(s) * r, Math.sin(s) * r);
        g.arc(0, 0, r, s, e);
      }
      g.stroke();
    };
    const poly = (g: Ctx, n: number, r: number, rotA: number) => {
      g.beginPath();
      for (let i = 0; i <= n; i++) {
        const a = rotA + (i / n) * TAU;
        i ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.stroke();
    };

    const fontPx = R * 0.042;
    ctx.font = FONT(fontPx);
    const glyphs = [...LEGEND.repeat(2)].map((ch) => ({ ch, w: ctx.measureText(ch).width + fontPx * 0.22 }));

    function builders(c: RGB, c2: RGB, energy: number): Record<Name, () => Layer> {
      return {
        bloom: () =>
          layer((g) => {
            const gr = g.createRadialGradient(0, 0, 0, 0, 0, R);
            gr.addColorStop(0, rgba(c, 1));
            gr.addColorStop(0.3, rgba(c, 0.3));
            gr.addColorStop(1, rgba(c, 0));
            g.fillStyle = gr;
            g.beginPath();
            g.arc(0, 0, R, 0, TAU);
            g.fill();
          }, 1, 0.25),
        scan: () =>
          layer((g) => {
            if (!("createConicGradient" in g)) return;
            const cg = g.createConicGradient(0, 0, 0);
            cg.addColorStop(0, rgba(c2, 0));
            cg.addColorStop(0.86, rgba(c2, 0));
            cg.addColorStop(0.995, rgba(c2, 1));
            cg.addColorStop(1, rgba(c2, 0));
            g.fillStyle = cg;
            g.beginPath();
            g.arc(0, 0, R * 0.84, 0, TAU);
            g.arc(0, 0, R * 0.32, 0, TAU, true);
            g.fill();
          }),
        bezel: () =>
          layer((g) => {
            const r1 = R * 0.975;
            const tiers: Array<[(i: number) => boolean, number, number, number]> = [
              [(i) => i % 15 === 0, R * 0.06, 0.85, 1.4],
              [(i) => i % 15 !== 0 && i % 5 === 0, R * 0.035, 0.42, 0.7],
              [(i) => i % 5 !== 0, R * 0.016, 0.2, 0.7],
            ];
            for (const [pick, len, alpha, w] of tiers) {
              g.strokeStyle = rgba(c, alpha);
              g.lineWidth = w;
              g.beginPath();
              for (let i = 0; i < 180; i++) {
                if (!pick(i)) continue;
                const a = (i / 180) * TAU;
                g.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
                g.lineTo(Math.cos(a) * (r1 - len), Math.sin(a) * (r1 - len));
              }
              g.stroke();
            }
            g.fillStyle = rgba(c2, 0.9);
            for (let i = 0; i < 4; i++) {
              g.save();
              g.rotate((i / 4) * TAU);
              g.beginPath();
              g.moveTo(R * 0.995, 0);
              g.lineTo(R * 0.95, -R * 0.018);
              g.lineTo(R * 0.95, R * 0.018);
              g.fill();
              g.restore();
            }
          }),
        legend: () =>
          layer((g) => {
            g.globalCompositeOperation = "source-over";
            g.font = FONT(fontPx);
            g.textAlign = "center";
            g.textBaseline = "middle";
            g.fillStyle = rgba(c, 0.55);
            const rText = R * 0.865;
            let ang = 0;
            for (const { ch, w } of glyphs) {
              ang += w / 2 / rText;
              if (ang > TAU - 0.02) break;
              g.save();
              g.rotate(ang);
              g.translate(0, -rText);
              g.fillText(ch, 0, 0);
              g.restore();
              ang += w / 2 / rText;
            }
          }),
        arc80: () =>
          layer((g) => {
            g.shadowBlur = (10 / 3) * px; // original: 10 device px at 3x density
            g.shadowColor = rgba(c, 0.8);
            arcs(g, R * 0.8, [[0, 0.95], [1.25, 1.55], [2.1, 3.35], [3.85, 4.05], [4.5, 5.85]], 2.2, 0.65, c);
          }),
        dash: () =>
          layer((g) => {
            g.setLineDash([1.5, 4]);
            g.lineWidth = 1;
            g.strokeStyle = rgba(c, 0.4);
            ring(g, R * 0.765);
          }),
        arc72: () =>
          layer((g) => {
            g.shadowBlur = (14 / 3) * px; // original: 14 device px at 3x density
            g.shadowColor = rgba(c2, 0.9);
            // intensity baked per palette so stroke + glow add and clip exactly as the original did
            arcs(g, R * 0.725, [[0, 1.05], [Math.PI, Math.PI + 1.05]], 3.5, 0.55 + 0.3 * energy, c2);
          }),
        arc69: () =>
          layer((g) => {
            arcs(g, R * 0.69, [[0.3, 0.42], [1.9, 2.02], [3.5, 3.62], [5.1, 5.22]], 5, 0.7, c);
            g.strokeStyle = rgba(c, 0.16);
            g.lineWidth = 0.8;
            ring(g, R * 0.665);
          }),
        hex: () =>
          layer((g) => {
            g.lineWidth = 1;
            g.strokeStyle = rgba(c, 0.5);
            poly(g, 6, R * 0.4, 0);
          }, 0.43),
        tri: () =>
          layer((g) => {
            g.lineWidth = 1;
            g.strokeStyle = rgba(c2, 0.35);
            poly(g, 3, R * 0.33, 0);
            poly(g, 3, R * 0.33, Math.PI);
          }, 0.36),
        dots: () =>
          layer((g) => {
            g.fillStyle = rgba(c, 0.6);
            g.beginPath();
            for (let i = 0; i < 48; i++) {
              const a = (i / 48) * TAU;
              const x = Math.cos(a) * R * 0.27;
              const y = Math.sin(a) * R * 0.27;
              const r = i % 4 === 0 ? 1.1 : 0.55;
              g.moveTo(x + r, y);
              g.arc(x, y, r, 0, TAU);
            }
            g.fill();
          }, 0.3),
        core: () =>
          layer((g) => {
            // drawn at the max radius; stamped scaled to the live pulse radius
            const cr = R * 0.99;
            const core = g.createRadialGradient(0, 0, 0, 0, 0, cr);
            core.addColorStop(0, "rgba(255,255,255,0.95)");
            core.addColorStop(0.22, rgba([(c2[0] + 255) / 2, (c2[1] + 255) / 2, (c2[2] + 255) / 2], 0.85));
            core.addColorStop(0.55, rgba(c, 0.45));
            core.addColorStop(1, rgba(c, 0));
            g.fillStyle = core;
            g.beginPath();
            g.arc(0, 0, cr, 0, TAU);
            g.fill();
          }, 1, 0.35),
      };
    }
    const buildAll = (mode: string) => {
      const b = builders(MODES[mode].c, MODES[mode].c2, MODES[mode].energy);
      return Object.fromEntries(NAMES.map((n) => [n, b[n]()])) as Layers;
    };
    const release = (set: Partial<Layers>) => {
      for (const l of Object.values(set)) if (l && "close" in l.img) (l.img as ImageBitmap).close();
    };

    // shown: current palette's layers. prev: the palette fading out.
    // pending: the next palette, built one layer per frame so a state change never spikes a frame.
    let shownMode = MODES[state] ? state : "idle";
    let shown = buildAll(shownMode);
    let prev: Layers | null = null;
    let pending: { mode: string; todo: Name[]; b: Record<Name, () => Layer>; out: Partial<Layers> } | null = null;
    let fadeStart = 0;
    let fade = 1;
    const FADE = 0.7;

    const stampOne = (l: Layer, angle: number, alpha: number, scale: number) => {
      if (alpha <= 0.002) return;
      const h = R * l.extent * scale;
      ctx.globalAlpha = alpha;
      if (angle === 0) ctx.drawImage(l.img, -h, -h, h * 2, h * 2);
      else {
        ctx.save();
        ctx.rotate(angle);
        ctx.drawImage(l.img, -h, -h, h * 2, h * 2);
        ctx.restore();
      }
    };
    const stamp = (name: Name, angle: number, alpha = 1, scale = 1) => {
      if (prev && fade < 1) {
        stampOne(prev[name], angle, alpha * (1 - fade), scale);
        stampOne(shown[name], angle, alpha * fade, scale);
      } else stampOne(shown[name], angle, alpha, scale);
      ctx.globalAlpha = 1;
    };

    // ── live state ─────────────────────────────────────────────────────
    const cur = { c: [...MODES[shownMode].c] as RGB, c2: [...MODES[shownMode].c2] as RGB, energy: 0.22, speed: 1, jitter: 0.15 };
    const rot = { a: 0, b: 0, c: 0, d: 0, scan: 0 };
    const TW_LEVELS = 4;
    const SZ_LEVELS = 3;
    const particles = Array.from({ length: 80 }, () => ({
      r: 0.4 + Math.random() * 0.52,
      a: Math.random() * TAU,
      v: (0.12 + Math.random() * 0.55) * (Math.random() < 0.5 ? -1 : 1),
      s: 0.4 + Math.random() * 1.2,
      ph: Math.random() * TAU,
      tb: 0, // twinkle bucket (updated per frame)
      sb: 0, // size bucket (fixed)
    }));
    for (const p of particles) p.sb = Math.min(SZ_LEVELS - 1, (((p.s - 0.4) / 1.2) * SZ_LEVELS) | 0);
    const ripples: number[] = [];
    let lastRipple = 0;
    let last = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < 15) return; // cap at ~60fps on high-refresh displays
      const dt = Math.min(0.05, (now - last) / 1000) * reduce;
      last = now;
      const t = now / 1000;
      const target = MODES[live.current] ? live.current : "idle";
      const m = MODES[target];
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

      // palette swap, one layer per frame, then crossfade
      if (target !== shownMode && pending?.mode !== target) {
        if (pending) release(pending.out);
        pending = { mode: target, todo: [...NAMES], b: builders(m.c, m.c2, m.energy), out: {} };
      }
      if (pending) {
        const name = pending.todo.shift()!;
        pending.out[name] = pending.b[name]();
        if (!pending.todo.length) {
          if (prev) release(prev);
          prev = shown;
          shown = pending.out as Layers;
          shownMode = pending.mode;
          pending = null;
          fadeStart = t;
        }
      }
      fade = prev ? Math.min(1, (t - fadeStart) / FADE) : 1;
      if (fade >= 1 && prev) {
        release(prev);
        prev = null;
      }

      ctx.setTransform(px, 0, 0, px, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.translate(R, R);
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";

      // 1 · ambient bloom
      stamp("bloom", 0, 0.2 + 0.2 * e);

      // 2 · ripples emitted from the core
      if (t - lastRipple > 2.8 / sp) (ripples.push(t), (lastRipple = t));
      while (ripples.length && t - ripples[0] > 2.4) ripples.shift();
      ctx.lineWidth = 1;
      for (const r0 of ripples) {
        const qq = (t - r0) / 2.4;
        ctx.strokeStyle = rgba(c, 0.32 * (1 - qq) * (1 - qq));
        ctx.beginPath();
        ctx.arc(0, 0, R * (0.24 + qq * 0.74), 0, TAU);
        ctx.stroke();
      }

      // 3 · scanner sweep
      stamp("scan", rot.scan, 0.1 + 0.22 * jt);
      // 4 · bezel
      stamp("bezel", rot.a);
      // 5 · legend ring
      ctx.globalCompositeOperation = "source-over";
      stamp("legend", rot.b);
      ctx.globalCompositeOperation = "lighter";
      // 6 · arc stack
      stamp("arc80", rot.c * 0.45);
      stamp("dash", rot.b * 1.6);
      stamp("arc72", rot.d * 0.6);
      stamp("arc69", -rot.c * 0.8);

      // 7 · voice waveform ring (base bars in one path, scanner-lit bars in 4 buckets)
      const N = 128;
      const env = 0.55 + 0.45 * Math.sin(t * 6.3) * Math.sin(t * 2.1 + 1);
      const inner = R * 0.5;
      const lit: number[][] = [[], [], [], []];
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = rgba(c, 0.3 + 0.25 * e);
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const a = (i / N) * TAU;
        const n = Math.sin(i * 0.47 + t * 3.1) * Math.sin(i * 0.11 - t * 1.6) + 0.5 * Math.sin(i * 1.3 + t * 7);
        let amp = (0.12 + e * 0.88) * (0.3 + 0.7 * Math.abs(n)) * (e > 0.8 ? env : 1);
        amp += jt * 0.25 * Math.random();
        let d = Math.abs((((a - rot.scan) % TAU) + TAU) % TAU);
        d = Math.min(d, TAU - d);
        const hl = Math.max(0, 1 - d / 0.55);
        const len = R * (0.012 + amp * 0.1 + hl * 0.05 * jt);
        const cs = Math.cos(a);
        const sn = Math.sin(a);
        if (hl > 0.05) lit[Math.min(3, (hl * 4) | 0)].push(cs, sn, len);
        else {
          ctx.moveTo(cs * inner, sn * inner);
          ctx.lineTo(cs * (inner + len), sn * (inner + len));
        }
      }
      ctx.stroke();
      for (let b = 0; b < 4; b++) {
        const arr = lit[b];
        if (!arr.length) continue;
        ctx.strokeStyle = rgba(c2, 0.3 + 0.5 * ((b + 0.5) / 4) + 0.25 * e);
        ctx.beginPath();
        for (let j = 0; j < arr.length; j += 3) {
          ctx.moveTo(arr[j] * inner, arr[j + 1] * inner);
          ctx.lineTo(arr[j] * (inner + arr[j + 2]), arr[j + 1] * (inner + arr[j + 2]));
        }
        ctx.stroke();
      }

      // 8 · orbiting particles (trails and dots batched by twinkle / size buckets)
      for (let tb = 0; tb < TW_LEVELS; tb++) {
        const tw = 0.35 + 0.65 * ((tb + 0.5) / TW_LEVELS);
        for (let sb = 0; sb < SZ_LEVELS; sb++) {
          ctx.beginPath();
          let any = false;
          for (const p of particles) {
            if (p.tb !== tb || p.sb !== sb) continue;
            const r = R * p.r;
            const a0 = p.a - p.v * 0.22;
            ctx.moveTo(Math.cos(a0) * r, Math.sin(a0) * r);
            ctx.arc(0, 0, r, a0, p.a, p.v < 0);
            any = true;
          }
          if (!any) continue;
          ctx.strokeStyle = rgba(c, 0.18 * tw);
          ctx.lineWidth = (0.4 + 1.2 * ((sb + 0.5) / SZ_LEVELS)) * 0.8;
          ctx.stroke();
        }
        for (const outer of [false, true]) {
          ctx.beginPath();
          let any = false;
          for (const p of particles) {
            if (p.tb !== tb || p.r > 0.7 !== outer) continue;
            const r = R * p.r;
            const x = Math.cos(p.a) * r;
            const y = Math.sin(p.a) * r;
            ctx.moveTo(x + p.s, y);
            ctx.arc(x, y, p.s, 0, TAU);
            any = true;
          }
          if (!any) continue;
          ctx.fillStyle = rgba(outer ? c2 : c, 0.75 * tw);
          ctx.fill();
        }
      }
      for (const p of particles) {
        p.a += p.v * dt * sp * 0.55;
        const tw = 0.5 + 0.5 * Math.sin(t * 2.5 + p.ph);
        p.tb = Math.min(TW_LEVELS - 1, (tw * TW_LEVELS) | 0);
      }

      // 9 · inner frame
      stamp("hex", rot.d * 0.25);
      stamp("tri", -rot.c * 0.5);
      ctx.strokeStyle = rgba(c, 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = rot.a * 2 + (i / 4) * TAU + Math.PI / 4;
        ctx.moveTo(Math.cos(a) * R * 0.36, Math.sin(a) * R * 0.36);
        ctx.lineTo(Math.cos(a) * R * 0.46, Math.sin(a) * R * 0.46);
      }
      ctx.stroke();
      stamp("dots", rot.c);

      // 10 · plasma core
      const pulse = 1 + Math.sin(t * 2.2) * 0.04 + (e > 0.8 ? 0.09 * env : 0) + jt * 0.02 * Math.sin(t * 17);
      stamp("core", 0, 1, (0.22 * pulse) / 0.99);
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
      if (c[0] > 200) {
        ctx.strokeStyle = rgba(c, 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(t * 6)));
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.99, 0, TAU);
        ctx.stroke();
      }
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      release(shown);
      if (prev) release(prev);
      if (pending) release(pending.out);
    };
  }, [size]);

  return <canvas ref={ref} className="orb" style={{ width: size, height: size }} />;
});
