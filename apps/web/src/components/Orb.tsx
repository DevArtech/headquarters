import { memo, useState } from "react";
import { Orb2D } from "./Orb2D";
import { Orb3D } from "./Orb3D";

/** WebGL available, and not overridden with ?orb=2d (handy for comparing performance). */
function want3d() {
  if (new URLSearchParams(location.search).get("orb") === "2d") return false;
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** G.A.R.T.H.'s core: the 3D WebGL version, falling back to the 2D canvas version. */
export const Orb = memo(function Orb({ state, size = 360 }: { state: string; size?: number }) {
  const [mode, setMode] = useState(() => (want3d() ? "3d" : "2d"));
  return mode === "3d" ? <Orb3D state={state} size={size} onFail={() => setMode("2d")} /> : <Orb2D state={state} size={size} />;
});
