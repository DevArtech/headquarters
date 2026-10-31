import { Background, BackgroundVariant, ReactFlow, useReactFlow, type Node } from "@xyflow/react";
import { useEffect, useMemo } from "react";
import { useStore } from "../store";
import { edgeTypes } from "./edges";
import { layout } from "./layout";
import { nodeTypes } from "./nodes";

export function Graph() {
  const state = useStore((s) => s.state);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);

  const { nodes, edges } = useMemo(() => (state ? layout(state) : { nodes: [], edges: [] }), [state]);
  const selId = selected && selected.kind !== "hq" ? selected.id : null;
  const withSel = useMemo(() => nodes.map((n) => ({ ...n, selected: n.id === selId })), [nodes, selId]);

  const onNodeClick = (_: unknown, n: Node) => {
    if (n.type === "hq") {
      select(null);
      document.getElementById("garth-input")?.focus();
    } else select({ kind: n.type as "outpost" | "task" | "agent", id: n.id });
  };

  return (
    <div className="graph">
      <ReactFlow
        nodes={withSel}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodeOrigin={[0.5, 0.5]}
        onNodeClick={onNodeClick}
        onPaneClick={() => select(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        fitView
        fitViewOptions={{ padding: 0.28, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={34} size={1} color="rgba(99,179,237,0.16)" />
        <AutoFit count={nodes.length} />
      </ReactFlow>
    </div>
  );
}

/** Re-frame the graph whenever nodes appear or disappear. */
function AutoFit({ count }: { count: number }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const id = setTimeout(() => fitView({ padding: 0.28, maxZoom: 1, duration: 700 }), 80);
    return () => clearTimeout(id);
  }, [count, fitView]);
  return null;
}
