import { getStraightPath, type EdgeProps } from "@xyflow/react";
import type { ConduitEdge } from "./layout";

/** Straight conduit between node centres. Active conduits carry pulses both ways: dispatch out, results back. */
export function ConduitEdgeView({ sourceX, sourceY, targetX, targetY, data }: EdgeProps<ConduitEdge>) {
  const trim = data?.trimStart ?? 0;
  const len = Math.hypot(targetX - sourceX, targetY - sourceY) || 1;
  const sx = sourceX + ((targetX - sourceX) / len) * trim;
  const sy = sourceY + ((targetY - sourceY) / len) * trim;
  const [path] = getStraightPath({ sourceX: sx, sourceY: sy, targetX, targetY });
  const kind = data?.kind ?? "link";
  return (
    <g className={`conduit ${kind} ${data?.active ? "active" : ""}`}>
      <path d={path} className="conduit-glow" />
      <path d={path} className="conduit-core" />
      {data?.active && (
        <>
          <g className="pulse out">
            <circle r={8} className="halo" />
            <circle r={3.2} className="dot" />
            <animateMotion dur="1.8s" repeatCount="indefinite" path={path} />
          </g>
          <g className="pulse back">
            <circle r={6} className="halo" />
            <circle r={2.2} className="dot" />
            <animateMotion dur="2.6s" repeatCount="indefinite" path={path} keyPoints="1;0" keyTimes="0;1" calcMode="linear" />
          </g>
        </>
      )}
    </g>
  );
}

export const edgeTypes = { conduit: ConduitEdgeView };
