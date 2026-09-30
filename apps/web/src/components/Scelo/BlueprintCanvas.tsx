// Blueprint-style building blocks for the Tools canvas (see modelPorts.ts):
// typed pins, the wires between them, the wire being dragged — which says
// whether the drop will take, and why not — and the "what can plug in
// here?" menu that opens when a wire is dropped on empty canvas, the way
// Unreal's context-sensitive action menu does.

import {
  type CSSProperties,
  type KeyboardEvent,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BaseEdge,
  type ConnectionLineComponentProps,
  EdgeLabelRenderer,
  type EdgeProps,
  Handle,
  Position,
  getBezierPath,
  useStore,
} from "reactflow";
import { FAMILY_COLOR_DARK, FAMILY_COLOR_LIGHT, type ModelFamily } from "./modelCatalog";
import {
  HUB_NODE_ID,
  PORT_TYPES,
  type PortType,
  checkConnection,
  modelIdOfNode,
  parseHandleId,
  portsOf,
} from "./modelPorts";
import type { ModelWire } from "./pipeline";

export type Theme = "light" | "dark";

/** Canvas-wide state the pins and the dragged wire read. */
export type BlueprintState = { theme: Theme; wires: ModelWire[] };

export const BlueprintContext = createContext<BlueprintState>({ theme: "dark", wires: [] });

export function portColorOf(type: PortType, theme: Theme): string {
  return PORT_TYPES[type].color[theme];
}

// ── pins ────────────────────────────────────────────────────────────────────

/** Height of one pin row — handles sit on the row's midline. */
export const PIN_ROW_H = 18;

/**
 * One typed pin. Data pins (from the dataset) are round, result pins (from
 * another model) are diamonds; hollow until something is plugged in, like a
 * Blueprint pin. A required input nothing can feed is drawn dashed in the
 * error colour.
 */
export function PinHandle({
  side,
  handleId,
  type,
  filled,
  missing = false,
  connectableStart = true,
  title,
}: {
  side: "in" | "out";
  handleId: string;
  type: PortType;
  filled: boolean;
  missing?: boolean;
  /** Dragging can START here (dataset-only inputs have nothing to offer). */
  connectableStart?: boolean;
  title?: string;
}) {
  const { theme } = useContext(BlueprintContext);
  const color = missing ? "rgb(var(--rgb-error))" : portColorOf(type, theme);
  const diamond = PORT_TYPES[type].provenance === "result";
  const style: CSSProperties = {
    width: 10,
    height: 10,
    top: "50%",
    ...(side === "in" ? { left: -6 } : { right: -6 }),
    transform: diamond ? "translate(0, -50%) rotate(45deg)" : "translate(0, -50%)",
    borderRadius: diamond ? 2 : "50%",
    background: filled ? color : "rgb(var(--rgb-bg-1))",
    border: `2px ${missing ? "dashed" : "solid"} ${color}`,
  };
  return (
    <Handle
      id={handleId}
      type={side === "in" ? "target" : "source"}
      position={side === "in" ? Position.Left : Position.Right}
      isConnectableStart={connectableStart}
      style={style}
      title={title}
    />
  );
}

// ── wires ───────────────────────────────────────────────────────────────────

export type WireEdgeData = {
  color: string;
  /** False when the wire's source is switched off: dashed, and the pin
   *  falls back to its default. */
  live: boolean;
  /** Model → model wires can be unplugged; dataset feeds cannot. */
  onRemove?: () => void;
  title?: string;
};

/** A Blueprint wire: a horizontal-tangent spline in the pin's colour. No
 *  arrowhead — pins read left (in) to right (out). */
export function WireEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<WireEdgeData>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const color = data?.color ?? "rgb(var(--rgb-border))";
  const live = data?.live ?? true;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={16}
        style={{
          stroke: color,
          strokeWidth: selected ? 2.6 : live ? 1.8 : 1.2,
          strokeDasharray: live ? undefined : "5 4",
          opacity: live ? 0.95 : 0.5,
        }}
      />
      {data?.onRemove && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <span aria-hidden className="relative inline-flex h-4 w-4">
              <span aria-hidden className="absolute inset-0 rounded-full bg-bg" />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  data.onRemove?.();
                }}
                title={data.title ?? "unplug this wire"}
                aria-label="unplug wire"
                className="relative flex h-4 w-4 items-center justify-center rounded-full border font-mono text-[10px] leading-none opacity-50 transition hover:border-error hover:text-error hover:opacity-100"
                style={{ borderColor: color, color }}
              >
                ×
              </button>
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** The type a pin carries, from its node + handle ids. */
export function pinTypeOf(
  nodeId: string | null | undefined,
  handleId: string | null | undefined,
): PortType | null {
  const h = parseHandleId(handleId);
  if (!h || !nodeId) return null;
  if (h.kind === "data") return nodeId === HUB_NODE_ID ? h.type : null;
  const modelId = modelIdOfNode(nodeId);
  if (!modelId) return null;
  const ports = portsOf(modelId);
  if (h.kind === "out") return ports.outputs.find((p) => p.id === h.port)?.type ?? null;
  return ports.inputs.find((p) => p.id === h.port)?.accepts[0] ?? null;
}

/**
 * The wire being dragged, in the dragged pin's colour, with a tag at the
 * cursor: what it carries, and — over a pin — whether the drop will take or
 * why it won't ("claim frequency can't feed mortality …"). The tag is
 * counter-scaled so it reads the same at any zoom.
 */
export function BlueprintConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
}: ConnectionLineComponentProps) {
  const { theme, wires } = useContext(BlueprintContext);
  const start = useStore((s) => s.connectionStartHandle);
  const end = useStore((s) => s.connectionEndHandle);
  const zoom = useStore((s) => s.transform[2]);
  const type = pinTypeOf(start?.nodeId, start?.handleId);
  const color = type ? portColorOf(type, theme) : "rgb(var(--rgb-fg-dim))";
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  });

  let tone: "ok" | "bad" | "info" = "info";
  let message = type
    ? start?.type === "source"
      ? `${PORT_TYPES[type].label} — drop on a matching input, or on empty canvas to add a model`
      : `${PORT_TYPES[type].label} — drop on empty canvas to add a model that makes it`
    : "";
  if (start && end && !(end.nodeId === start.nodeId && end.handleId === start.handleId)) {
    const fromSource = start.type === "source";
    const check = checkConnection(
      fromSource
        ? {
            source: start.nodeId,
            sourceHandle: start.handleId ?? null,
            target: end.nodeId,
            targetHandle: end.handleId ?? null,
          }
        : {
            source: end.nodeId,
            sourceHandle: end.handleId ?? null,
            target: start.nodeId,
            targetHandle: start.handleId ?? null,
          },
      wires,
    );
    if (check.ok) {
      tone = "ok";
      message =
        check.action.kind === "none"
          ? "already plugged in"
          : check.action.kind === "data"
            ? "release to feed it from the dataset instead"
            : "release to plug in";
    } else {
      tone = "bad";
      message = check.reason;
    }
  }
  const scale = zoom > 0 ? 1 / zoom : 1;
  return (
    <g>
      <path
        d={path}
        fill="none"
        stroke={tone === "bad" ? "rgb(var(--rgb-error))" : color}
        strokeWidth={2}
        strokeDasharray={tone === "bad" ? "5 4" : undefined}
      />
      {message && (
        <foreignObject
          x={toX + 12 * scale}
          y={toY + 10 * scale}
          width={1}
          height={1}
          style={{ overflow: "visible", pointerEvents: "none" }}
        >
          <div
            style={{ transform: `scale(${scale})`, transformOrigin: "0 0", width: "max-content" }}
            className={`max-w-[300px] rounded border bg-bg-1 px-1.5 py-0.5 font-mono text-[10px] leading-snug shadow-md ${
              tone === "ok"
                ? "border-primary/60 text-primary"
                : tone === "bad"
                  ? "border-error/60 text-error"
                  : "border-border text-fg-mute"
            }`}
          >
            {tone === "ok" ? "✓ " : tone === "bad" ? "✗ " : ""}
            {message}
          </div>
        </foreignObject>
      )}
    </g>
  );
}

// ── the "what can plug in here?" menu ──────────────────────────────────────

export type MenuEntry = {
  /** Model id, or "dataset" for the re-plug-the-dataset entry. */
  key: string;
  name: string;
  family: ModelFamily | null;
  /** One line under the name: what gets plugged, or why it can't. */
  hint: string;
  enabled: boolean;
  /** Marks entries that are already on the canvas. */
  attached?: boolean;
};

export type MenuSection = { title: string; entries: MenuEntry[] };

/**
 * Context menu of models that fit where the wire was dropped (or, from a
 * right-click, every model), models the data can't feed greyed out with the
 * reason. Type to filter, ↑/↓ to move, Enter to pick, Esc to close.
 */
export function AddModelMenu({
  x,
  y,
  title,
  subtitle,
  sections,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  title: string;
  subtitle?: string;
  sections: MenuSection[];
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const { theme } = useContext(BlueprintContext);
  const palette = theme === "light" ? FAMILY_COLOR_LIGHT : FAMILY_COLOR_DARK;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sections
      .map((s) => ({
        ...s,
        entries: q
          ? s.entries.filter(
              (e) =>
                e.name.toLowerCase().includes(q) ||
                e.key.toLowerCase().includes(q) ||
                (e.family ?? "").includes(q),
            )
          : s.entries,
      }))
      .filter((s) => s.entries.length > 0);
  }, [sections, query]);
  const pickable = useMemo(
    () => filtered.flatMap((s) => s.entries).filter((e) => e.enabled),
    [filtered],
  );

  // Keep the highlight on something pickable as the filter narrows.
  useEffect(() => {
    setActive((a) => (pickable.length === 0 ? 0 : Math.min(a, pickable.length - 1)));
  }, [pickable.length]);

  // Close on a press anywhere outside.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as globalThis.Node)) onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (pickable.length ? (a + 1) % pickable.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (pickable.length ? (a - 1 + pickable.length) % pickable.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = pickable[active];
      if (pick) onPick(pick.key);
    }
  };

  const activeKey = pickable[active]?.key;
  return (
    <section
      ref={rootRef}
      className="nodrag nowheel absolute z-30 flex w-[300px] flex-col overflow-hidden rounded-xl border border-border bg-bg-1 shadow-xl"
      style={{ left: x, top: y }}
      aria-label={title}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="border-b border-border px-2.5 pb-1.5 pt-2">
        <div className="font-mono text-[10px] uppercase tracking-wider text-fg-dim">{title}</div>
        {subtitle && <div className="mt-0.5 text-[11px] leading-snug text-fg-mute">{subtitle}</div>}
        <input
          // biome-ignore lint/a11y/noAutofocus: the menu exists to be typed into.
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="search models…"
          className="mt-1.5 w-full rounded border border-border bg-bg px-1.5 py-1 font-mono text-[11px] text-fg outline-none placeholder:text-fg-dim focus:border-primary"
        />
      </div>
      <div className="scrollbar-none max-h-[320px] overflow-auto p-1">
        {filtered.length === 0 && (
          <p className="px-2 py-3 text-center text-[11px] text-fg-dim">Nothing matches.</p>
        )}
        {filtered.map((s) => (
          <div key={s.title} className="mb-1 last:mb-0">
            <div className="px-1.5 pb-0.5 pt-1 font-mono text-[9px] uppercase tracking-wider text-fg-dim">
              {s.title}
            </div>
            {s.entries.map((e) => {
              const color = e.family ? palette[e.family] : "rgb(var(--rgb-primary))";
              const isActive = e.enabled && e.key === activeKey;
              return (
                <button
                  key={e.key}
                  type="button"
                  disabled={!e.enabled}
                  onClick={() => onPick(e.key)}
                  onMouseEnter={() => {
                    const i = pickable.findIndex((p) => p.key === e.key);
                    if (i >= 0) setActive(i);
                  }}
                  title={e.hint}
                  className={`flex w-full flex-col items-start rounded px-1.5 py-1 text-left transition ${
                    isActive ? "bg-bg-2" : ""
                  } ${e.enabled ? "cursor-pointer" : "cursor-not-allowed opacity-45"}`}
                >
                  <span className="flex w-full items-center gap-1.5">
                    <span
                      aria-hidden
                      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: color }}
                    />
                    <span className="truncate text-[11.5px] text-fg">{e.name}</span>
                    {e.attached && (
                      <span className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                        on canvas
                      </span>
                    )}
                  </span>
                  <span className="line-clamp-2 pl-3 text-[10px] leading-snug text-fg-dim">
                    {e.hint}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
