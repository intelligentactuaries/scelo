// A scroll container that (a) uses the quiet, thin, hover-only `.scroll-soft`
// scrollbar and (b) softly fades the content at any edge where it's clipped —
// and only those edges. At the start of a scroll axis there's no top/left
// fade; once you scroll in, a fade appears behind you and stays ahead of you
// until you reach the far end. The fade is a CSS mask gradient, so it costs
// nothing to paint and never intercepts pointer events.
//
//   <ScrollFade axis="y" className="max-h-36 overflow-auto">…</ScrollFade>
//   <ScrollFade axis="both" className="max-h-40 overflow-auto">…</ScrollFade>

import {
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type UIEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

// px over which each clipped edge fades to transparent.
const FADE = 18;

type Edges = { top: boolean; bottom: boolean; left: boolean; right: boolean };

function edgeGradient(dir: "to bottom" | "to right", fadeStart: boolean, fadeEnd: boolean): string {
  const a = fadeStart ? FADE : 0;
  const b = fadeEnd ? FADE : 0;
  return `linear-gradient(${dir}, transparent 0, #000 ${a}px, #000 calc(100% - ${b}px), transparent 100%)`;
}

export function ScrollFade({
  axis = "y",
  className = "",
  style,
  onScroll,
  children,
  ...rest
}: {
  axis?: "x" | "y" | "both";
  children: ReactNode;
} & HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState<Edges>({
    top: false,
    bottom: false,
    left: false,
    right: false,
  });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // 1px slack so sub-pixel layouts don't leave a permanent hairline fade.
    setEdges({
      top: el.scrollTop > 1,
      bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    });
  }, []);

  // Recompute on mount and whenever the content/box resizes (rows added,
  // narrative streamed in, node resized).
  useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [update]);

  const masks: string[] = [];
  if (axis === "y" || axis === "both") masks.push(edgeGradient("to bottom", edges.top, edges.bottom));
  if (axis === "x" || axis === "both") masks.push(edgeGradient("to right", edges.left, edges.right));
  const maskValue = masks.join(", ");
  // When both axes fade, intersect the two masks so corners fade correctly.
  const composite = masks.length > 1 ? "intersect" : undefined;
  const webkitComposite = masks.length > 1 ? "source-in" : undefined;

  const maskStyle: CSSProperties = {
    WebkitMaskImage: maskValue,
    maskImage: maskValue,
    WebkitMaskComposite: webkitComposite,
    maskComposite: composite,
    ...style,
  };

  return (
    <div
      ref={ref}
      className={`scroll-soft ${className}`}
      style={maskStyle}
      onScroll={(e: UIEvent<HTMLDivElement>) => {
        update();
        onScroll?.(e);
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
