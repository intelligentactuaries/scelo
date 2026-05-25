// The single React Flow component. All node-link views on the web go through this.

import { useMemo } from "react";
import ReactFlow, { Background, Controls, type Edge, type Node, Position } from "reactflow";
import "reactflow/dist/style.css";
import type { FlowGraphSpec } from "@/lib/api";
import { useTheme } from "@/lib/theme";

const STATUS_BORDER_DARK: Record<string, string> = {
  idle: "#2a2a2a",
  running: "#00d68f",
  blocked: "#ffb454",
  done: "#7aa2f7",
  error: "#ff6b6b",
};

const STATUS_BORDER_LIGHT: Record<string, string> = {
  idle: "#dcdad5",
  running: "#009669",
  blocked: "#a86614",
  done: "#3760cc",
  error: "#b73a3a",
};

type Props = {
  spec: FlowGraphSpec;
  className?: string;
};

export function FlowGraph({ spec, className }: Props) {
  const { resolved } = useTheme();
  const palette =
    resolved === "light"
      ? {
          nodeBg: "#f4f4f3",
          nodeFg: "#181818",
          gridDot: "#dcdad5",
          panelBg: "#ffffff",
          panelBorder: "#dcdad5",
          edge: "#bdbdb8",
          status: STATUS_BORDER_LIGHT,
        }
      : {
          nodeBg: "#141414",
          nodeFg: "#e8e8e8",
          gridDot: "#1a1a1a",
          panelBg: "#141414",
          panelBorder: "#2a2a2a",
          edge: "#2a2a2a",
          status: STATUS_BORDER_DARK,
        };

  const nodes: Node[] = useMemo(
    () =>
      spec.nodes.map((n, i) => ({
        id: n.id,
        type: "default",
        position: n.position ?? { x: 200 * i, y: 0 },
        data: { label: n.label },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          background: palette.nodeBg,
          color: palette.nodeFg,
          border: `1px solid ${palette.status[n.status ?? "idle"]}`,
          borderRadius: 4,
          padding: 8,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
        },
      })),
    [spec, palette],
  );
  const edges: Edge[] = useMemo(
    () =>
      spec.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        animated: e.animated ?? false,
        label: e.label,
        style: { stroke: palette.edge },
      })),
    [spec, palette],
  );

  return (
    <div className={className}>
      <ReactFlow nodes={nodes} edges={edges} fitView proOptions={{ hideAttribution: true }}>
        <Background color={palette.gridDot} gap={16} />
        <Controls
          showInteractive={false}
          style={{ background: palette.panelBg, border: `1px solid ${palette.panelBorder}` }}
        />
      </ReactFlow>
    </div>
  );
}
