import { memo, useEffect, useRef } from "react";
import * as THREE from "three";
import { readVoice } from "../tts";

type RGB = [number, number, number];

/** Per-state targets (same palette as the 2D core). The core eases between them. */
const MODES: Record<string, { c: RGB; c2: RGB; energy: number; speed: number; jitter: number }> = {
  idle: { c: [79, 209, 255], c2: [46, 230, 197], energy: 0.22, speed: 1, jitter: 0.15 },
  thinking: { c: [155, 123, 255], c2: [79, 209, 255], energy: 0.55, speed: 3.4, jitter: 1 },
  speaking: { c: [46, 230, 197], c2: [140, 240, 255], energy: 1, speed: 1.7, jitter: 0.35 },
  alert: { c: [255, 181, 71], c2: [255, 92, 122], energy: 0.7, speed: 1.3, jitter: 0.4 },
};

const LEGEND = " G.A.R.T.H.  ◆  GENERAL AGENT FOR ROUTING · TASKING · HANDOFFS  ◆  HEADQUARTERS CORE  ◆ ";
const TAU = Math.PI * 2;

// Ashima Arts 3D simplex noise (MIT)
const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1./6.,1./3.); const vec4 D=vec4(0.,.5,1.,2.);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
  float n_=.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.+1.; vec4 s1=floor(b1)*2.+1.; vec4 sh=-step(h,vec4(0.));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.); m=m*m;
  return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

/**
 * G.A.R.T.H.'s core in 3D (WebGL, three.js): a noise-displaced plasma sphere inside nested wireframe
 * polyhedra and a geodesic dot shell, three gimballed rings with ticks and satellites, a rotating
 * legend band, a radar sweep disc, a voice-spectrum ring, ~1800 orbiting particles and ripples.
 * Everything blends additively. While G.A.R.T.H. speaks, the live voice audio drives the core's
 * swelling and glow, the spectrum ring and the particle burst.
 */
export const Orb3D = memo(function Orb3D({ state, size = 360, onFail }: { state: string; size?: number; onFail?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef(state);
  live.current = state;
  const fail = useRef(onFail);
  fail.current = onFail;

  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch {
      fail.current?.();
      return;
    }
    const px = Math.min(2, window.devicePixelRatio || 1);
    renderer.setPixelRatio(px);
    renderer.setSize(size, size);
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);
    const onLost = (e: Event) => {
      e.preventDefault();
      fail.current?.();
    };
    renderer.domElement.addEventListener("webglcontextlost", onLost);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    camera.position.set(0, 0, 10.2); // visible half-height at the origin ≈ 2.73
    const root = new THREE.Group();
    scene.add(root);

    const U = {
      uTime: { value: 0 },
      uSpin: { value: 0 }, // accumulated rotation (speed-scaled), so speed changes never jump
      uScan: { value: 0 },
      uColor: { value: new THREE.Color() },
      uColor2: { value: new THREE.Color() },
      uEnergy: { value: 0.22 },
      uAudio: { value: 0 },
      uJitter: { value: 0.15 },
      uPx: { value: px },
    };
    const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;
    const trash: Array<{ dispose(): void }> = [];
    const keep = <T extends { dispose(): void }>(x: T) => (trash.push(x), x);
    const tinted: Array<{ m: THREE.LineBasicMaterial | THREE.MeshBasicMaterial | THREE.SpriteMaterial; which: 1 | 2 | 3; k: number }> = [];
    const tint = <M extends THREE.LineBasicMaterial | THREE.MeshBasicMaterial | THREE.SpriteMaterial>(m: M, which: 1 | 2 | 3, k = 1) => (tinted.push({ m, which, k }), keep(m));

    // soft round glow texture for sprites
    const glowTex = keep(
      new THREE.CanvasTexture(
        (() => {
          const c = document.createElement("canvas");
          c.width = c.height = 128;
          const g = c.getContext("2d")!;
          const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
          gr.addColorStop(0, "rgba(255,255,255,1)");
          gr.addColorStop(0.25, "rgba(255,255,255,0.45)");
          gr.addColorStop(0.6, "rgba(255,255,255,0.08)");
          gr.addColorStop(1, "rgba(255,255,255,0)");
          g.fillStyle = gr;
          g.fillRect(0, 0, 128, 128);
          return c;
        })(),
      ),
    );

    // ── 1 · plasma core ──
    const core = new THREE.Mesh(
      keep(new THREE.IcosahedronGeometry(0.62, 12)),
      keep(
        new THREE.ShaderMaterial({
          uniforms: U,
          ...additive,
          vertexShader: /* glsl */ `
            uniform float uTime, uEnergy, uAudio, uJitter;
            varying vec3 vN; varying vec3 vV; varying float vNoise;
            ${NOISE}
            void main(){
              vec3 p = position; vec3 d = normalize(p);
              float n1 = snoise(d*1.7 + vec3(0., uTime*.35, uTime*.21));
              float n2 = snoise(d*4.3 - vec3(uTime*.55, 0., uTime*.4));
              vNoise = n1*.65 + n2*.35;
              float amp = .035 + .05*uEnergy + .26*uAudio + .03*uJitter;
              p += normal * vNoise * amp;
              vec4 mv = modelViewMatrix * vec4(p, 1.);
              vN = normalize(normalMatrix * normal); vV = -mv.xyz;
              gl_Position = projectionMatrix * mv;
            }`,
          fragmentShader: /* glsl */ `
            uniform vec3 uColor, uColor2; uniform float uAudio, uEnergy;
            varying vec3 vN; varying vec3 vV; varying float vNoise;
            void main(){
              float fres = pow(1. - abs(dot(normalize(vN), normalize(vV))), 2.3);
              vec3 hot = mix(vec3(1.), uColor2, .4);
              float plasma = .5 + .5*vNoise;
              vec3 col = hot*(.25 + .75*plasma)*(.55 + .7*uAudio + .15*uEnergy) + uColor*fres*(1.5 + 1.2*uAudio);
              gl_FragColor = vec4(col, .45 + .55*fres);
            }`,
        }),
      ),
    );
    root.add(core);
    const glowOuter = new THREE.Sprite(tint(new THREE.SpriteMaterial({ map: glowTex, ...additive, opacity: 0.55 }), 1));
    const glowInner = new THREE.Sprite(tint(new THREE.SpriteMaterial({ map: glowTex, ...additive, opacity: 0.9 }), 3));
    root.add(glowOuter, glowInner);

    // ── 2 · nested wireframe polyhedra ──
    const wire = (geo: THREE.BufferGeometry, which: 1 | 2, opacity: number) => {
      const m = tint(new THREE.LineBasicMaterial({ ...additive, opacity }), which);
      const l = new THREE.LineSegments(keep(new THREE.EdgesGeometry(keep(geo))), m);
      root.add(l);
      return l;
    };
    const ico = wire(new THREE.IcosahedronGeometry(0.98, 1), 1, 0.55);
    const octa = wire(new THREE.OctahedronGeometry(1.16, 0), 2, 0.4);
    const shellLines = wire(new THREE.IcosahedronGeometry(1.42, 3), 1, 0.09);

    // ── 3 · geodesic dot shell ──
    const shellPts = (() => {
      const src = new THREE.IcosahedronGeometry(1.42, 3);
      const pos = src.getAttribute("position");
      const seen = new Set<string>();
      const out: number[] = [];
      for (let i = 0; i < pos.count; i++) {
        const k = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      }
      src.dispose();
      const g = keep(new THREE.BufferGeometry());
      g.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
      const phase = new Float32Array(out.length / 3).map(() => Math.random() * TAU);
      g.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
      const m = keep(
        new THREE.ShaderMaterial({
          uniforms: U,
          ...additive,
          vertexShader: /* glsl */ `
            uniform float uTime, uPx, uAudio; attribute float aPhase; varying float vA;
            void main(){
              vec4 mv = modelViewMatrix * vec4(position*(1. + .05*uAudio*sin(aPhase*3.)), 1.);
              vA = .45 + .55*(.5 + .5*sin(uTime*2. + aPhase));
              gl_PointSize = uPx * 2.4 * (10. / -mv.z);
              gl_Position = projectionMatrix * mv;
            }`,
          fragmentShader: /* glsl */ `
            uniform vec3 uColor2; varying float vA;
            void main(){ float d = length(gl_PointCoord - .5); gl_FragColor = vec4(uColor2, smoothstep(.5, .1, d) * vA * .9); }`,
        }),
      );
      const p = new THREE.Points(g, m);
      root.add(p);
      return p;
    })();

    // ── 4 · gimballed rings with ticks, dashes and satellites ──
    type Ring = { gimbal: THREE.Group; spin: THREE.Group; sat: THREE.Sprite; r: number; rate: number; satRate: number };
    const rings: Ring[] = [];
    const ring = (r: number, tilt: [number, number, number], rate: number, which: 1 | 2, dashes: number) => {
      const gimbal = new THREE.Group();
      gimbal.rotation.set(...tilt);
      const spin = new THREE.Group();
      gimbal.add(spin);
      const circle: number[] = [];
      for (let i = 0; i <= 192; i++) {
        const a = (i / 192) * TAU;
        circle.push(Math.cos(a) * r, Math.sin(a) * r, 0);
      }
      const cg = keep(new THREE.BufferGeometry());
      cg.setAttribute("position", new THREE.Float32BufferAttribute(circle, 3));
      spin.add(new THREE.Line(cg, tint(new THREE.LineBasicMaterial({ ...additive, opacity: 0.22 }), which)));
      // bright dashed arcs
      const arcs: number[] = [];
      for (let k = 0; k < dashes; k++) {
        const a0 = (k / dashes) * TAU;
        const len = (TAU / dashes) * (0.25 + 0.5 * ((k * 0.618) % 1));
        for (let s = 0; s < 16; s++) {
          const a = a0 + (s / 16) * len;
          const b = a0 + ((s + 1) / 16) * len;
          arcs.push(Math.cos(a) * r, Math.sin(a) * r, 0, Math.cos(b) * r, Math.sin(b) * r, 0);
        }
      }
      const ag = keep(new THREE.BufferGeometry());
      ag.setAttribute("position", new THREE.Float32BufferAttribute(arcs, 3));
      spin.add(new THREE.LineSegments(ag, tint(new THREE.LineBasicMaterial({ ...additive, opacity: 0.85 }), which)));
      // ticks (major every 10)
      const ticks: number[] = [];
      for (let i = 0; i < 120; i++) {
        const a = (i / 120) * TAU;
        const l = i % 10 === 0 ? 0.12 : 0.05;
        ticks.push(Math.cos(a) * r, Math.sin(a) * r, 0, Math.cos(a) * (r + l), Math.sin(a) * (r + l), 0);
      }
      const tg = keep(new THREE.BufferGeometry());
      tg.setAttribute("position", new THREE.Float32BufferAttribute(ticks, 3));
      spin.add(new THREE.LineSegments(tg, tint(new THREE.LineBasicMaterial({ ...additive, opacity: 0.4 }), which)));
      const sat = new THREE.Sprite(tint(new THREE.SpriteMaterial({ map: glowTex, ...additive }), 3));
      sat.scale.setScalar(0.26);
      gimbal.add(sat);
      root.add(gimbal);
      rings.push({ gimbal, spin, sat, r, rate, satRate: -rate * 2.3 });
    };
    ring(1.78, [1.18, 0, 0.12], 0.32, 1, 6);
    ring(1.98, [0.42, 0.7, 0], -0.21, 2, 4);
    ring(2.16, [-0.35, -0.55, 0.9], 0.15, 1, 9);

    // ── 5 · legend band (text wrapped round a cylinder; only the near side faces us) ──
    const legendTex = keep(
      new THREE.CanvasTexture(
        (() => {
          const c = document.createElement("canvas");
          c.width = 2048;
          c.height = 64;
          const g = c.getContext("2d")!;
          g.fillStyle = "#fff";
          g.font = '600 34px "JetBrains Mono", ui-monospace, monospace';
          g.textBaseline = "middle";
          const text = LEGEND.repeat(3);
          let x = 0;
          for (const ch of text) {
            if (x > c.width) break;
            g.fillText(ch, x, 34);
            x += g.measureText(ch).width + 7;
          }
          return c;
        })(),
      ),
    );
    legendTex.wrapS = THREE.RepeatWrapping;
    legendTex.repeat.x = -1; // read left-to-right from outside
    const band = new THREE.Mesh(
      keep(new THREE.CylinderGeometry(2.42, 2.42, 0.13, 160, 1, true)),
      tint(new THREE.MeshBasicMaterial({ map: legendTex, ...additive, opacity: 0.55, side: THREE.FrontSide }), 1),
    );
    band.rotation.x = 0.2;
    root.add(band);

    // ── 6 · radar sweep disc ──
    const radar = new THREE.Mesh(
      keep(new THREE.CircleGeometry(2.3, 128)),
      keep(
        new THREE.ShaderMaterial({
          uniforms: U,
          ...additive,
          side: THREE.DoubleSide,
          vertexShader: /* glsl */ `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
          fragmentShader: /* glsl */ `
            uniform vec3 uColor, uColor2; uniform float uScan, uJitter, uAudio; varying vec2 vP;
            void main(){
              float r = length(vP) / 2.3; float a = atan(vP.y, vP.x);
              float s = fract((a - uScan) / 6.2831853);
              float sweep = pow(1. - s, 26.) * (.18 + .4*uJitter) * smoothstep(.3, .36, r) * smoothstep(1., .9, r);
              float grid = (1. - smoothstep(0., .012, abs(fract(r*6.) - .5) - .488)) * .5 * smoothstep(.3, .35, r);
              float spokes = (1. - smoothstep(0., .02, abs(fract(a/6.2831853*12.) - .5) - .48)) * .25 * smoothstep(.35, .4, r);
              vec3 col = uColor2*sweep + uColor*(grid + spokes)*.16*(1. + uAudio);
              gl_FragColor = vec4(col, 1.);
            }`,
        }),
      ),
    );
    radar.rotation.x = -1.2;
    root.add(radar);

    // ── 7 · voice spectrum ring (mirrored bands, rising from a tilted circle) ──
    const BARS = 96;
    const barPos = new Float32Array(BARS * 6);
    const barGeo = keep(new THREE.BufferGeometry());
    barGeo.setAttribute("position", new THREE.BufferAttribute(barPos, 3).setUsage(THREE.DynamicDrawUsage));
    const bars = new THREE.LineSegments(barGeo, tint(new THREE.LineBasicMaterial({ ...additive, opacity: 0.95 }), 2));
    const barBase: number[] = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * TAU;
      barBase.push(Math.cos(a) * 1.56, Math.sin(a) * 1.56, 0);
    }
    const bbg = keep(new THREE.BufferGeometry());
    bbg.setAttribute("position", new THREE.Float32BufferAttribute(barBase, 3));
    const barRing = new THREE.Group();
    barRing.add(bars, new THREE.Line(bbg, tint(new THREE.LineBasicMaterial({ ...additive, opacity: 0.3 }), 2)));
    barRing.rotation.x = -1.2;
    root.add(barRing);

    // ── 8 · orbiting particles (Keplerian swirl: inner ones faster) ──
    const N = 1800;
    const pg = keep(new THREE.BufferGeometry());
    const aR = new Float32Array(N), aT = new Float32Array(N), aY = new Float32Array(N), aPh = new Float32Array(N), aSz = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      aR[i] = 1.45 + Math.pow(Math.random(), 0.7) * 0.95; // stays inside the canvas even when speech pushes it out
      aT[i] = Math.random() * TAU;
      aY[i] = (Math.random() - 0.5) * (Math.random() < 0.7 ? 0.35 : 1.6);
      aPh[i] = Math.random() * 100;
      aSz[i] = 0.6 + Math.random() * 1.6;
    }
    pg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    pg.setAttribute("aR", new THREE.BufferAttribute(aR, 1));
    pg.setAttribute("aT", new THREE.BufferAttribute(aT, 1));
    pg.setAttribute("aY", new THREE.BufferAttribute(aY, 1));
    pg.setAttribute("aPh", new THREE.BufferAttribute(aPh, 1));
    pg.setAttribute("aSz", new THREE.BufferAttribute(aSz, 1));
    const particles = new THREE.Points(
      pg,
      keep(
        new THREE.ShaderMaterial({
          uniforms: U,
          ...additive,
          vertexShader: /* glsl */ `
            uniform float uTime, uSpin, uAudio, uPx; attribute float aR, aT, aY, aPh, aSz; varying float vA; varying float vOuter;
            void main(){
              float r = aR * (1. + uAudio * .1 * fract(aPh * 7.13));
              float a = aT + uSpin * 1.9 / pow(aR, 1.5);
              vec3 p = vec3(cos(a) * r, aY * (1. + uAudio * .5), sin(a) * r);
              vec4 mv = modelViewMatrix * vec4(p, 1.);
              float tw = .5 + .5 * sin(uTime * 2.3 + aPh);
              vA = (.25 + .75 * tw) * (.6 + .4 * uAudio);
              vOuter = step(2.1, aR);
              gl_PointSize = uPx * aSz * (.8 + .4 * tw) * (10. / -mv.z);
              gl_Position = projectionMatrix * mv;
            }`,
          fragmentShader: /* glsl */ `
            uniform vec3 uColor, uColor2; varying float vA; varying float vOuter;
            void main(){ float d = length(gl_PointCoord - .5); gl_FragColor = vec4(mix(uColor, uColor2, vOuter), smoothstep(.5, .05, d) * vA); }`,
        }),
      ),
    );
    particles.frustumCulled = false; // positions are computed in the shader
    particles.rotation.x = 0.38;
    particles.rotation.z = -0.12;
    root.add(particles);

    // ── 9 · ripples from the core (and the alert halo) ──
    const ripples = Array.from({ length: 3 }, () => {
      const m = tint(new THREE.MeshBasicMaterial({ ...additive, opacity: 0 }), 1);
      const mesh = new THREE.Mesh(keep(new THREE.RingGeometry(0.98, 1, 128)), m);
      scene.add(mesh); // camera-facing, outside the wobbling root
      return { mesh, m, born: -10 };
    });
    let nextRipple = 0;

    // ── frame loop ──
    const cur = { c: [...MODES.idle.c] as RGB, c2: [...MODES.idle.c2] as RGB, energy: 0.22, speed: 1, jitter: 0.15, audio: 0 };
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.25 : 1;
    const col1 = new THREE.Color(), col2 = new THREE.Color(), col3 = new THREE.Color();
    let last = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < 15) return; // ~60fps cap on high-refresh displays
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
      // live voice: fast attack, slower release
      const v = readVoice(t);
      cur.audio += (v.level - cur.audio) * (v.level > cur.audio ? 0.45 : 0.12);
      const { energy: e, speed: sp, jitter: jt, audio: au } = cur;

      col1.setRGB(cur.c[0] / 255, cur.c[1] / 255, cur.c[2] / 255, THREE.SRGBColorSpace);
      col2.setRGB(cur.c2[0] / 255, cur.c2[1] / 255, cur.c2[2] / 255, THREE.SRGBColorSpace);
      col3.copy(col2).lerp(new THREE.Color(1, 1, 1), 0.55);
      U.uColor.value.copy(col1);
      U.uColor2.value.copy(col2);
      for (const { m: mat, which } of tinted) mat.color.copy(which === 1 ? col1 : which === 2 ? col2 : col3);
      U.uTime.value = t;
      U.uSpin.value += dt * 0.55 * sp * (1 + au * 0.6);
      U.uScan.value += dt * (0.7 + sp * 0.9);
      U.uEnergy.value = e;
      U.uAudio.value = au;
      U.uJitter.value = jt;

      // gentle 3D drift so the depth reads
      root.rotation.y = Math.sin(t * 0.13) * 0.32;
      root.rotation.x = Math.sin(t * 0.09 + 1) * 0.14;

      const pulse = 1 + Math.sin(t * 2.2) * 0.04 + au * 0.3 + jt * 0.02 * Math.sin(t * 17);
      core.scale.setScalar(pulse);
      core.rotation.y += dt * 0.2 * sp;
      glowOuter.scale.setScalar(3.6 * (1 + au * 0.45 + e * 0.12));
      (glowOuter.material as THREE.SpriteMaterial).opacity = 0.35 + 0.25 * e + 0.35 * au;
      glowInner.scale.setScalar(1.7 * pulse);
      ico.rotation.x += dt * 0.31 * sp;
      ico.rotation.y -= dt * 0.47 * sp;
      octa.rotation.y += dt * 0.6 * sp;
      octa.rotation.z -= dt * 0.22 * sp;
      shellLines.rotation.y -= dt * 0.06 * sp;
      shellPts.rotation.y = shellLines.rotation.y;
      shellLines.scale.setScalar(1 + au * 0.04);
      shellPts.scale.copy(shellLines.scale);
      band.rotation.y -= dt * 0.09 * sp;
      for (const r of rings) {
        r.spin.rotation.z += dt * r.rate * sp;
        r.gimbal.rotation.y += dt * 0.03 * sp;
        const a = t * r.satRate * (0.6 + 0.4 * sp);
        r.sat.position.set(Math.cos(a) * r.r, Math.sin(a) * r.r, 0);
        r.sat.scale.setScalar(0.22 + au * 0.25);
      }

      // spectrum bars: 48 bands mirrored round the circle, idle shimmer when silent
      for (let i = 0; i < BARS; i++) {
        const band = i < BARS / 2 ? i : BARS - 1 - i;
        const idle = 0.03 + 0.04 * e * (0.5 + 0.5 * Math.sin(i * 0.9 + t * 3.1) * Math.sin(i * 0.23 - t * 1.7));
        const len = idle + v.bands[band] * 0.75;
        const a = (i / BARS) * TAU + Math.PI / 2;
        const ca = Math.cos(a), sa = Math.sin(a), r0 = 1.58;
        barPos.set([ca * r0, sa * r0, 0, ca * (r0 + len), sa * (r0 + len), 0], i * 6);
      }
      barGeo.attributes.position.needsUpdate = true;
      barRing.rotation.z += dt * 0.05 * sp;

      // ripples: emitted on a beat (faster when busy, on loud syllables when speaking)
      if (t > nextRipple || (au > 0.55 && t - ripples.reduce((x, r) => Math.max(x, r.born), -10) > 0.35)) {
        const r = ripples.reduce((o, r) => (r.born < o.born ? r : o));
        r.born = t;
        nextRipple = t + 2.8 / sp;
      }
      const alert = cur.c[0] > 200;
      for (const r of ripples) {
        const q = (t - r.born) / 2.2;
        if (q < 0 || q > 1) {
          r.m.opacity = 0;
          continue;
        }
        r.mesh.scale.setScalar(0.7 + q * 1.95);
        r.m.opacity = (alert ? 0.6 : 0.35) * (1 - q) * (1 - q);
      }

      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      renderer.domElement.removeEventListener("webglcontextlost", onLost);
      for (const x of trash) x.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [size]);

  return <div ref={host} className="orb" style={{ width: size, height: size }} />;
});
