import { Background, BackgroundVariant, Controls, ReactFlow, type Node } from "@xyflow/react";
import { useMemo } from "react";
import { useStore } from "../store";
import { layout } from "./layout";
import { nodeTypes } from "./nodes";

export function Graph() {
  const state = useStore((s) => s.state);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);

  const { nodes, edges } = useMemo(() => (state ? layout(state) : { nodes: [], edges: [] }), [state]);
  const selId = selected && selected.kind !== "hq" ? selected.id : selected ? "hq" : null;
  const withSel = useMemo(() => nodes.map((n) => ({ ...n, selected: n.id === selId })), [nodes, selId]);

  const onNodeClick = (_: unknown, n: Node) => {
    if (n.type === "hq") select({ kind: "hq" });
    else if (n.type === "outpost") select({ kind: "outpost", id: n.id });
    else if (n.type === "task") select({ kind: "task", id: n.id });
    else if (n.type === "agent") select({ kind: "agent", id: n.id });
  };

  return (
    <>
      <ReactFlow
        nodes={withSel}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={() => select(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.25 }}
        minZoom={0.3}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="rgba(99,179,237,0.18)" />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="legend">
        <span><i style={{ borderColor: "var(--teal)" }} />local</span>
        <span><i style={{ borderColor: "var(--violet)", borderStyle: "dashed" }} />cloud</span>
        <span><i style={{ borderColor: "var(--amber)" }} />needs you</span>
      </div>
    </>
  );
}
