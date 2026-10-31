import { memo, useEffect, useRef } from "react";
import * as THREE from "three";
import type { GarthBrainKind } from "@hq/protocol";
import { deriveVitals, ORB_KEY, type Vitals } from "../orb-vitals";
import { activeChannelOf, useStore } from "../store";
import { readVoice } from "../tts";

type RGB = [number, number, number];

/** Per-state targets (same palette as the 2D core). The core eases between them. */
const MODES: Record<string, { c: RGB; c2: RGB; energy: number; speed: number; jitter: number }> = {
  idle: { c: [79, 209, 255], c2: [46, 230, 197], energy: 0.22, speed: 1, jitter: 0.15 },
  thinking: { c: [155, 123, 255], c2: [79, 209, 255], energy: 0.55, speed: 3.4, jitter: 1 },
  speaking: { c: [46, 230, 197], c2: [140, 240, 255], energy: 1, speed: 1.7, jitter: 0.35 },
  alert: { c: [255, 181, 71], c2: [255, 92, 122], energy: 0.7, speed: 1.3, jitter: 0.4 },
};

const TAU = Math.PI * 2;
const LAP_MS = 10 * 60_000; // rings 2 and 3: one lap = 10 minutes of a task running
const TICKS = 120; // one tick = 5 s on the task rings
const MAX_SATS = 12;
const AMBER = new THREE.Color(1, 0.71, 0.28);
const RED = new THREE.Color(1, 0.36, 0.48);

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

/** Stable angle for a radar blip from its id. */
function hashAngle(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) / 4294967296) * TAU;
}

/**
 * G.A.R.T.H.'s core in 3D (WebGL, three.js). Every element shows something real (see ORB_KEY):
 * plasma = G.A.R.T.H. and its voice; inner polyhedra = installed brains; dotted shell = the HQ
 * machine; ring 1 = other devices; rings 2–3 = tasks on HQ and in the cloud on a 10-minute clock;
 * band = live status; radar = notifications; bar ring = voice or recent activity; particles = event
 * flow; ripples = events as they happen. All additive.
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
      uSpin: { value: 0 }, // accumulated particle swirl (flow-scaled), so rate changes never jump
      uScan: { value: 0 },
      uColor: { value: new THREE.Color() },
      uColor2: { value: new THREE.Color() },
      uEnergy: { value: 0.22 },
      uAudio: { value: 0 },
      uJitter: { value: 0.15 },
      uPx: { value: px },
      uLoad: { value: 0 }, // HQ machine CPU load
      uBeat: { value: 0 }, // HQ heartbeat flash, decays
      uFlow: { value: 0 }, // event flow rate
      uBurst: { value: 0 }, // a new event just happened, decays
      uBlips: { value: Array.from({ length: MAX_SATS }, () => new THREE.Vector4()) },
      uBlipCount: { value: 0 },
    };
    const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;
    const trash: Array<{ dispose(): void }> = [];
    const keep = <T extends { dispose(): void }>(x: T) => (trash.push(x), x);
    const tinted: Array<{ m: THREE.LineBasicMaterial | THREE.MeshBasicMaterial | THREE.SpriteMaterial; which: 1 | 2 | 3 }> = [];
    const tint = <M extends THREE.LineBasicMaterial | THREE.MeshBasicMaterial | THREE.SpriteMaterial>(m: M, which: 1 | 2 | 3) => (tinted.push({ m, which }), keep(m));
    const lineGeo = (pts: number[]) => {
      const g = keep(new THREE.BufferGeometry());
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      return g;
    };
    const dynamicLines = (maxVerts: number, colors = false) => {
      const g = keep(new THREE.BufferGeometry());
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(maxVerts * 3), 3).setUsage(THREE.DynamicDrawUsage));
      if (colors) g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(maxVerts * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.setDrawRange(0, 0);
      return g;
    };

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

    // ── plasma core: G.A.R.T.H. (voice swells it; channels at work churn it) ──
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
              float churn = .35 + .5*uJitter;
              float n1 = snoise(d*1.7 + vec3(0., uTime*churn, uTime*.21));
              float n2 = snoise(d*4.3 - vec3(uTime*.55*(1. + uJitter), 0., uTime*.4));
              vNoise = n1*.65 + n2*.35;
              float amp = .035 + .05*uEnergy + .26*uAudio + .04*uJitter;
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

    // ── inner polyhedra: one per installed brain ──
    const brainShape: Record<GarthBrainKind, THREE.BufferGeometry> = {
      "claude-code": new THREE.IcosahedronGeometry(0.98, 1),
      codex: new THREE.OctahedronGeometry(1.16, 0),
      antigravity: new THREE.DodecahedronGeometry(1.06, 0),
      api: new THREE.TetrahedronGeometry(1.24, 0),
    };
    const brainMesh = new Map<GarthBrainKind, { line: THREE.LineSegments; mat: THREE.LineBasicMaterial; spin: number; axis: THREE.Vector3 }>();
    (Object.keys(brainShape) as GarthBrainKind[]).forEach((kind, i) => {
      const mat = keep(new THREE.LineBasicMaterial({ ...additive, opacity: 0 }));
      const line = new THREE.LineSegments(keep(new THREE.EdgesGeometry(keep(brainShape[kind]))), mat);
      line.visible = false;
      root.add(line);
      brainMesh.set(kind, { line, mat, spin: 0.15, axis: new THREE.Vector3(Math.sin(i * 2.1), 1, Math.cos(i * 1.3)).normalize() });
    });

    // ── dotted geodesic shell: the HQ machine ──
    const shellLineMat = tint(new THREE.LineBasicMaterial({ ...additive, opacity: 0.09 }), 1);
    const shellLines = new THREE.LineSegments(keep(new THREE.EdgesGeometry(keep(new THREE.IcosahedronGeometry(1.42, 3)))), shellLineMat);
    root.add(shellLines);
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
      const g = lineGeo(out);
      g.setAttribute("aPhase", new THREE.BufferAttribute(new Float32Array(out.length / 3).map(() => Math.random() * TAU), 1));
      const p = new THREE.Points(
        g,
        keep(
          new THREE.ShaderMaterial({
            uniforms: U,
            ...additive,
            vertexShader: /* glsl */ `
              uniform float uTime, uPx, uLoad, uBeat; attribute float aPhase; varying float vA;
              void main(){
                vec4 mv = modelViewMatrix * vec4(position*(1. + .04*uBeat), 1.);
                float tw = .5 + .5*sin(uTime*(1.2 + 5.*uLoad) + aPhase);
                vA = (.3 + .7*tw) * (.35 + .65*uLoad) + .8*uBeat;
                gl_PointSize = uPx * 2.4 * (10. / -mv.z);
                gl_Position = projectionMatrix * mv;
              }`,
            fragmentShader: /* glsl */ `
              uniform vec3 uColor2; varying float vA;
              void main(){ float d = length(gl_PointCoord - .5); gl_FragColor = vec4(uColor2, smoothstep(.5, .1, d) * vA * .9); }`,
          }),
        ),
      );
      root.add(p);
      return p;
    })();

    // ── rings: fleet (1), tasks on HQ (2), cloud tasks (3) ──
    interface Ring {
      gimbal: THREE.Group;
      face: THREE.Group;
      r: number;
      sats: THREE.Sprite[];
      satMats: THREE.SpriteMaterial[];
      ticks: THREE.BufferGeometry;
      arcs: THREE.BufferGeometry;
    }
    const makeRing = (r: number, tilt: [number, number, number]): Ring => {
      const gimbal = new THREE.Group();
      gimbal.rotation.set(...tilt);
      const face = new THREE.Group();
      gimbal.add(face);
      const circle: number[] = [];
      for (let i = 0; i <= 192; i++) {
        const a = (i / 192) * TAU;
        circle.push(Math.cos(a) * r, Math.sin(a) * r, 0);
      }
      face.add(new THREE.Line(lineGeo(circle), tint(new THREE.LineBasicMaterial({ ...additive, opacity: 0.22 }), 1)));
      // ticks: vertex-coloured so they can act as a gauge or a clock
      const ticks = dynamicLines(TICKS * 2, true);
      const tp = ticks.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < TICKS; i++) {
        const a = Math.PI / 2 - (i / TICKS) * TAU; // clockwise from the top
        const l = i % 12 === 0 ? 0.13 : 0.05;
        tp.setXYZ(i * 2, Math.cos(a) * r, Math.sin(a) * r, 0);
        tp.setXYZ(i * 2 + 1, Math.cos(a) * (r + l), Math.sin(a) * (r + l), 0);
      }
      ticks.setDrawRange(0, TICKS * 2);
      face.add(new THREE.LineSegments(ticks, keep(new THREE.LineBasicMaterial({ ...additive, vertexColors: true }))));
      // arcs: per-item arcs (fleet) or elapsed-time trails (tasks)
      const arcs = dynamicLines(MAX_SATS * 64 * 2, true);
      face.add(new THREE.LineSegments(arcs, keep(new THREE.LineBasicMaterial({ ...additive, vertexColors: true }))));
      const satMats: THREE.SpriteMaterial[] = [];
      const sats = Array.from({ length: MAX_SATS }, () => {
        const m = keep(new THREE.SpriteMaterial({ map: glowTex, ...additive }));
        satMats.push(m);
        const s = new THREE.Sprite(m);
        s.visible = false;
        face.add(s);
        return s;
      });
      root.add(gimbal);
      return { gimbal, face, r, sats, satMats, ticks, arcs };
    };
    const fleetRing = makeRing(1.78, [1.18, 0, 0.12]);
    const localRing = makeRing(1.98, [0.42, 0.7, 0]);
    const cloudRing = makeRing(2.16, [-0.35, -0.55, 0.9]);

    /** Write an arc into a dynamic line geometry; returns the next vertex index. */
    const arc = (g: THREE.BufferGeometry, v: number, r: number, a0: number, a1: number, col: THREE.Color, segs: number) => {
      const p = g.getAttribute("position") as THREE.BufferAttribute;
      const c = g.getAttribute("color") as THREE.BufferAttribute;
      for (let s = 0; s < segs && v + 1 < p.count; s++) {
        const x = a0 + ((a1 - a0) * s) / segs;
        const y = a0 + ((a1 - a0) * (s + 1)) / segs;
        p.setXYZ(v, Math.cos(x) * r, Math.sin(x) * r, 0);
        p.setXYZ(v + 1, Math.cos(y) * r, Math.sin(y) * r, 0);
        c.setXYZ(v, col.r, col.g, col.b);
        c.setXYZ(v + 1, col.r, col.g, col.b);
        v += 2;
      }
      return v;
    };
    const finish = (g: THREE.BufferGeometry, v: number) => {
      g.setDrawRange(0, v);
      g.getAttribute("position").needsUpdate = true;
      g.getAttribute("color").needsUpdate = true;
    };
    const paintTicks = (ring: Ring, lit: (i: number) => number, on: THREE.Color, off: THREE.Color) => {
      const c = ring.ticks.getAttribute("color") as THREE.BufferAttribute;
      const tmp = new THREE.Color();
      for (let i = 0; i < TICKS; i++) {
        const k = lit(i);
        tmp.copy(off).lerp(on, k).multiplyScalar(i % 12 === 0 ? 1 : 0.6);
        c.setXYZ(i * 2, tmp.r, tmp.g, tmp.b);
        c.setXYZ(i * 2 + 1, tmp.r, tmp.g, tmp.b);
      }
      c.needsUpdate = true;
    };

    // ── band: live status line wrapped round a cylinder ──
    const bandCanvas = document.createElement("canvas");
    bandCanvas.width = 2048;
    bandCanvas.height = 64;
    const legendTex = keep(new THREE.CanvasTexture(bandCanvas));
    legendTex.wrapS = THREE.RepeatWrapping;
    legendTex.repeat.x = -1; // read left-to-right from outside
    let tickerShown = "";
    const drawTicker = (text: string) => {
      const g = bandCanvas.getContext("2d")!;
      g.clearRect(0, 0, bandCanvas.width, bandCanvas.height);
      g.fillStyle = "#fff";
      g.font = '600 34px "JetBrains Mono", ui-monospace, monospace';
      g.textBaseline = "middle";
      let x = 0;
      while (x < bandCanvas.width) {
        for (const ch of text) {
          if (x > bandCanvas.width) break;
          g.fillText(ch, x, 34);
          x += g.measureText(ch).width + 7;
        }
      }
      legendTex.needsUpdate = true;
      tickerShown = text;
    };
    drawTicker("G.A.R.T.H.  ◆  CONNECTING  ◆  ");
    const band = new THREE.Mesh(
      keep(new THREE.CylinderGeometry(2.42, 2.42, 0.13, 160, 1, true)),
      tint(new THREE.MeshBasicMaterial({ map: legendTex, ...additive, opacity: 0.6, side: THREE.FrontSide }), 1),
    );
    band.rotation.x = 0.2;
    root.add(band);

    // ── radar: notifications as blips; the sweep lights them as it passes ──
    const radar = new THREE.Mesh(
      keep(new THREE.CircleGeometry(2.3, 128)),
      keep(
        new THREE.ShaderMaterial({
          uniforms: U,
          ...additive,
          side: THREE.DoubleSide,
          vertexShader: /* glsl */ `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
          fragmentShader: /* glsl */ `
            uniform vec3 uColor, uColor2; uniform float uScan, uJitter, uAudio, uTime; uniform vec4 uBlips[${MAX_SATS}]; uniform int uBlipCount;
            varying vec2 vP;
            void main(){
              float r = length(vP) / 2.3; float a = atan(vP.y, vP.x);
              float s = fract((a - uScan) / 6.2831853);
              float sweep = pow(1. - s, 26.) * (.18 + .4*uJitter) * smoothstep(.3, .36, r) * smoothstep(1., .9, r);
              // range rings every 1/6 of the radius and 12 spokes: thin lines, a scale for the blips
              float ringD = abs(fract(r*6. + .5) - .5) / 6.;          // distance to the nearest ring, in radius units
              float grid = (1. - smoothstep(0., .006, ringD)) * .5 * smoothstep(.3, .35, r);
              float spokeD = abs(fract(a/6.2831853*12. + .5) - .5) * 6.2831853/12. * r; // arc distance to nearest spoke
              float spokes = (1. - smoothstep(0., .008, spokeD)) * .25 * smoothstep(.35, .4, r);
              vec3 col = uColor2*sweep + uColor*(grid + spokes)*.16*(1. + uAudio);
              for (int i = 0; i < ${MAX_SATS}; i++) {
                if (i >= uBlipCount) break;
                vec4 b = uBlips[i]; // angle, radius 0-1, kind, unused
                vec2 bp = vec2(cos(b.x), sin(b.x)) * b.y * 2.3;
                float d = length(vP - bp);
                float since = fract((uScan - b.x) / 6.2831853); // 0 = the sweep just passed it
                float lit = .35 + 1.4*exp(-since*7.);
                vec3 bc = b.z > 2.5 ? vec3(1., .71, .28) : b.z > 1.5 ? vec3(1., .36, .48) : b.z > .5 ? uColor2 : uColor;
                if (b.z > 2.5) lit += .9*(.5 + .5*sin(uTime*6.)); // decision waiting: pulse
                col += bc * lit * (smoothstep(.09, 0., d) + .35*smoothstep(.22, .0, d));
              }
              // opacity follows brightness: dark parts of the disc stay see-through on the page
              gl_FragColor = vec4(col, min(1., max(col.r, max(col.g, col.b))));
            }`,
          // add light without darkening: colour adds fully, canvas opacity adds by brightness
          blending: THREE.CustomBlending,
          blendSrc: THREE.OneFactor,
          blendDst: THREE.OneFactor,
          blendSrcAlpha: THREE.OneFactor,
          blendDstAlpha: THREE.OneFactor,
        }),
      ),
    );
    radar.rotation.x = -1.2;
    root.add(radar);

    // ── bar ring: live voice spectrum, else the last 8 minutes of activity ──
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
    const barRing = new THREE.Group();
    barRing.add(bars, new THREE.Line(lineGeo(barBase), tint(new THREE.LineBasicMaterial({ ...additive, opacity: 0.3 }), 2)));
    barRing.rotation.x = -1.2;
    root.add(barRing);
    const history = new Float32Array(BARS);
    let voiceMix = 0;

    // ── particles: event flow (Keplerian swirl; faster and brighter with more events) ──
    const N = 1800;
    const pg = keep(new THREE.BufferGeometry());
    const aR = new Float32Array(N), aT = new Float32Array(N), aY = new Float32Array(N), aPh = new Float32Array(N), aSz = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      aR[i] = 1.45 + Math.pow(Math.random(), 0.7) * 0.95; // stays inside the canvas even when pushed out
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
            uniform float uTime, uSpin, uAudio, uPx, uFlow, uBurst; attribute float aR, aT, aY, aPh, aSz; varying float vA; varying float vOuter;
            void main(){
              float r = aR * (1. + (uAudio*.1 + uBurst*.09) * fract(aPh * 7.13));
              float a = aT + uSpin * 1.9 / pow(aR, 1.5);
              vec3 p = vec3(cos(a) * r, aY * (1. + uAudio * .5), sin(a) * r);
              vec4 mv = modelViewMatrix * vec4(p, 1.);
              float tw = .5 + .5 * sin(uTime * 2.3 + aPh);
              vA = (.25 + .75 * tw) * (.35 + .45*uFlow + .4*uAudio + .4*uBurst);
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

    // ── ripples: fired by events (and loud syllables), coloured by what happened ──
    const ripples = Array.from({ length: 6 }, () => {
      const m = keep(new THREE.MeshBasicMaterial({ ...additive, opacity: 0 }));
      const mesh = new THREE.Mesh(keep(new THREE.RingGeometry(0.98, 1, 128)), m);
      scene.add(mesh); // camera-facing, outside the drifting root
      return { mesh, m, born: -10, strength: 0, color: new THREE.Color() };
    });
    const ripple = (t: number, color: THREE.Color, strength: number) => {
      const r = ripples.reduce((o, r) => (r.born < o.born ? r : o));
      r.born = t;
      r.strength = strength;
      r.color.copy(color);
    };

    // ── vitals: HQ state, re-derived a few times a second ──
    let vitals: Vitals | null = null;
    let prevMarks: Vitals["marks"] | null = null;
    let vitalsAt = 0;
    const readVitals = (t: number) => {
      const st = useStore.getState();
      if (!st.state) return;
      const v = deriveVitals(st.state, activeChannelOf(st)?.id);
      const prev = prevMarks;
      prevMarks = v.marks;
      vitals = v;
      if (v.ticker !== tickerShown) drawTicker(v.ticker);
      if (!prev) return;
      // what happened since the last reading → ripples and a particle burst
      const seenNotes = new Set(prev.notes);
      for (const id of v.marks.notes) {
        if (seenNotes.has(id)) continue;
        const n = v.notes.find((x) => x.id === id);
        ripple(t, n?.kind === 3 ? AMBER : n?.kind === 2 ? RED : col2, 0.7);
        U.uBurst.value = 1;
      }
      const seenTasks = new Set(prev.taskStates);
      if (v.marks.taskStates.some((s) => !seenTasks.has(s))) {
        ripple(t, col2, 0.55);
        U.uBurst.value = 1;
      }
      if (v.marks.lastMessage && v.marks.lastMessage !== prev.lastMessage) {
        ripple(t, col1, 0.5);
        U.uBurst.value = Math.max(U.uBurst.value, 0.6);
      }
      if (v.marks.beat !== prev.beat) {
        ripple(t, col1, 0.14); // heartbeat: the link to HQ's machine is alive
        U.uBeat.value = 1;
      }
    };

    // ── frame loop ──
    const cur = { c: [...MODES.idle.c] as RGB, c2: [...MODES.idle.c2] as RGB, energy: 0.22, speed: 1, jitter: 0.15, audio: 0, load: 0, fleetLoad: 0, flow: 0 };
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.25 : 1;
    const col1 = new THREE.Color(), col2 = new THREE.Color(), col3 = new THREE.Color(), dim = new THREE.Color(), tmp = new THREE.Color();
    const WHITE = new THREE.Color(1, 1, 1);
    let last = performance.now();
    let raf = 0;
    let lastSyllable = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < 15) return; // ~60fps cap on high-refresh displays
      const dt = Math.min(0.05, (now - last) / 1000) * reduce;
      last = now;
      const t = now / 1000;
      const wall = Date.now();
      if (now - vitalsAt > 250) {
        vitalsAt = now;
        readVitals(t);
      }
      const V = vitals;
      const m = MODES[live.current] ?? MODES.idle;
      const k = 1 - Math.pow(0.03, dt);
      for (let i = 0; i < 3; i++) {
        cur.c[i] += (m.c[i] - cur.c[i]) * k;
        cur.c2[i] += (m.c2[i] - cur.c2[i]) * k;
      }
      cur.energy += (m.energy - cur.energy) * k;
      cur.speed += (m.speed - cur.speed) * k;
      const churn = Math.min(3, V?.busyChannels ?? 0) * 0.22; // more channels at work → more churn
      cur.jitter += (m.jitter + churn - cur.jitter) * k;
      cur.load += ((V?.hq?.load ?? 0) - cur.load) * k;
      cur.fleetLoad += ((V?.fleetLoad ?? 0) - cur.fleetLoad) * k;
      const recent = V ? V.events.filter((ts) => ts > wall - 30_000).length : 0;
      cur.flow += (Math.min(1, recent / 20) - cur.flow) * k;
      // live voice: fast attack, slower release
      const v = readVoice(t);
      cur.audio += (v.level - cur.audio) * (v.level > cur.audio ? 0.45 : 0.12);
      const { energy: e, speed: sp, jitter: jt, audio: au } = cur;

      col1.setRGB(cur.c[0] / 255, cur.c[1] / 255, cur.c[2] / 255, THREE.SRGBColorSpace);
      col2.setRGB(cur.c2[0] / 255, cur.c2[1] / 255, cur.c2[2] / 255, THREE.SRGBColorSpace);
      col3.copy(col2).lerp(WHITE, 0.55);
      dim.copy(col1).multiplyScalar(0.16);
      U.uColor.value.copy(col1);
      U.uColor2.value.copy(col2);
      for (const { m: mat, which } of tinted) mat.color.copy(which === 1 ? col1 : which === 2 ? col2 : col3);
      U.uTime.value = t;
      U.uSpin.value += dt * (0.25 + 1.6 * cur.flow) * (1 + au * 0.6);
      U.uScan.value += dt * (0.7 + sp * 0.9);
      U.uEnergy.value = e;
      U.uAudio.value = au;
      U.uJitter.value = jt;
      U.uLoad.value = cur.load;
      U.uFlow.value = cur.flow;
      U.uBeat.value *= Math.pow(0.12, dt);
      U.uBurst.value *= Math.pow(0.2, dt);

      // gentle 3D drift so the depth reads
      root.rotation.y = Math.sin(t * 0.13) * 0.32;
      root.rotation.x = Math.sin(t * 0.09 + 1) * 0.14;

      // plasma + glow: G.A.R.T.H.'s presence
      const pulse = 1 + Math.sin(t * 2.2) * 0.04 + au * 0.3 + jt * 0.02 * Math.sin(t * 17);
      core.scale.setScalar(pulse);
      core.rotation.y += dt * 0.2 * sp;
      glowOuter.scale.setScalar(3.6 * (1 + au * 0.45 + e * 0.12));
      (glowOuter.material as THREE.SpriteMaterial).opacity = 0.35 + 0.25 * e + 0.35 * au;
      glowInner.scale.setScalar(1.7 * pulse);

      // brains: shown if installed; brightest = this channel's; spin while mid-reply
      for (const [kind, b] of brainMesh) {
        const info = V?.brains.find((x) => x.kind === kind);
        b.line.visible = !!info;
        if (!info) continue;
        const target = info.busy ? 1.1 + (info.current ? 0.6 : 0) : 0.12;
        b.spin += (target - b.spin) * k;
        b.line.rotateOnAxis(b.axis, dt * b.spin * sp);
        b.mat.color.copy(info.current ? col1 : col2);
        b.mat.opacity += ((info.current ? 0.62 : 0.2) + (info.busy ? 0.2 : 0) - b.mat.opacity) * k;
      }

      // HQ machine: brightness = load, flash on heartbeat
      shellLineMat.opacity = 0.05 + 0.3 * cur.load + 0.25 * U.uBeat.value;
      shellLines.rotation.y -= dt * (0.04 + 0.2 * cur.load);
      shellPts.rotation.y = shellLines.rotation.y;
      band.rotation.y -= dt * 0.09;

      // ring 1: other devices; ticks fill like a dial with their average load
      {
        const fleet = V?.fleet ?? [];
        fleetRing.face.rotation.z += dt * 0.05;
        fleetRing.gimbal.rotation.y += dt * 0.03;
        paintTicks(fleetRing, (i) => (i / TICKS < cur.fleetLoad ? 1 : 0), col1, dim);
        let vtx = 0;
        const slot = fleet.length ? TAU / fleet.length : TAU;
        fleet.forEach((o, i) => {
          const a0 = Math.PI / 2 - i * slot - slot * 0.08;
          vtx = arc(fleetRing.arcs, vtx, fleetRing.r, a0, a0 - slot * 0.84, o.online ? tmp.copy(col1).multiplyScalar(0.8) : tmp.copy(RED).multiplyScalar(0.35), 24);
        });
        finish(fleetRing.arcs, vtx);
        fleetRing.sats.forEach((s, i) => {
          const o = fleet[i];
          s.visible = !!o;
          if (!o) return;
          const a = Math.PI / 2 - i * slot - slot * 0.5;
          s.position.set(Math.cos(a) * fleetRing.r, Math.sin(a) * fleetRing.r, 0);
          s.scale.setScalar(o.online ? 0.2 + o.load * 0.25 : 0.14);
          fleetRing.satMats[i].color.copy(o.online ? col3 : RED);
          fleetRing.satMats[i].opacity = o.online ? 1 : 0.45;
        });
      }

      // rings 2 and 3: tasks on a 10-minute clock (ticks = 5 s), trails = elapsed time
      const clockRing = (ring: Ring, items: Vitals["local"], hot: THREE.Color) => {
        ring.gimbal.rotation.y += dt * 0.02;
        const oldest = items.reduce((mx, it) => Math.max(mx, Math.min(1, (wall - it.started) / LAP_MS)), 0);
        paintTicks(ring, (i) => (i / TICKS < oldest ? 0.7 : 0), hot, dim);
        let vtx = 0;
        items.slice(0, MAX_SATS).forEach((it, i) => {
          const frac = ((wall - it.started) % LAP_MS) / LAP_MS;
          vtx = arc(ring.arcs, vtx, ring.r - 0.035 * (i + 1), Math.PI / 2, Math.PI / 2 - frac * TAU, tmp.copy(it.waiting ? AMBER : hot).multiplyScalar(0.55), Math.max(2, Math.round(frac * 64)));
        });
        finish(ring.arcs, vtx);
        ring.sats.forEach((s, i) => {
          const it = items[i];
          s.visible = !!it;
          if (!it) return;
          const frac = ((wall - it.started) % LAP_MS) / LAP_MS;
          const a = Math.PI / 2 - frac * TAU;
          const rr = ring.r - 0.035 * (i + 1);
          s.position.set(Math.cos(a) * rr, Math.sin(a) * rr, 0);
          const blink = it.waiting ? 0.5 + 0.5 * Math.sin(t * 7) : 1;
          s.scale.setScalar(0.24 + au * 0.15);
          ring.satMats[i].color.copy(it.waiting ? AMBER : col3);
          ring.satMats[i].opacity = blink;
        });
      };
      clockRing(localRing, V?.local ?? [], col2);
      clockRing(cloudRing, V?.cloud ?? [], col1);

      // radar blips: notifications (newest near the rim)
      const notes = V?.notes ?? [];
      notes.forEach((n, i) => {
        const age = Math.min(1, (wall - n.ts) / (30 * 60_000));
        U.uBlips.value[i].set(hashAngle(n.id), 0.92 - 0.5 * age, n.kind, 0);
      });
      U.uBlipCount.value = notes.length;

      // bar ring: voice spectrum while speaking, else activity over the last 8 minutes
      voiceMix += ((v.level > 0.02 || au > 0.05 ? 1 : 0) - voiceMix) * Math.min(1, dt * 4);
      if (V) {
        history.fill(0);
        for (const ts of V.events) {
          const bin = Math.floor((wall - ts) / 5000);
          if (bin >= 0 && bin < BARS) history[bin]++;
        }
      }
      let peak = 3;
      for (let i = 0; i < BARS; i++) peak = Math.max(peak, history[i]);
      for (let i = 0; i < BARS; i++) {
        const bandIdx = i < BARS / 2 ? i : BARS - 1 - i;
        const voiceLen = 0.02 + v.bands[bandIdx] * 0.75;
        const histLen = 0.02 + (history[i] / peak) * 0.42; // i = 0 is the newest 5 s, at the top
        const len = voiceLen * voiceMix + histLen * (1 - voiceMix);
        const a = Math.PI / 2 - (i / BARS) * TAU;
        const ca = Math.cos(a), sa = Math.sin(a), r0 = 1.58;
        barPos.set([ca * r0, sa * r0, 0, ca * (r0 + len), sa * (r0 + len), 0], i * 6);
      }
      barGeo.attributes.position.needsUpdate = true;

      // speech: loud syllables send ripples too
      if (au > 0.55 && t - lastSyllable > 0.35) {
        lastSyllable = t;
        ripple(t, col1, 0.4);
      }
      for (const r of ripples) {
        const q = (t - r.born) / 2.2;
        if (q < 0 || q > 1) {
          r.m.opacity = 0;
          continue;
        }
        r.mesh.scale.setScalar(0.7 + q * 1.95);
        r.m.color.copy(r.color);
        r.m.opacity = r.strength * (1 - q) * (1 - q);
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

  return <div ref={host} className="orb" title={ORB_KEY} style={{ width: size, height: size }} />;
});
