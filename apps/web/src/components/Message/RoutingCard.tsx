// Subtle "thinking" indicator. Collapses to one line once streaming
// finishes (i.e. when isStreaming is false on the parent).

type Props = {
  band: "high" | "medium" | "low";
  tool?: string;
  confidence?: number;
  isStreaming: boolean;
};

const BAND_LABEL: Record<Props["band"], string> = {
  high: "high confidence",
  medium: "medium confidence",
  low: "low confidence",
};

const BAND_COLOR: Record<Props["band"], string> = {
  high: "text-primary",
  medium: "text-warn",
  low: "text-fg-mute",
};

export function RoutingCard({ band, tool, confidence, isStreaming }: Props) {
  const pct = typeof confidence === "number" ? `${Math.round(confidence * 100)}%` : null;
  return (
    <div className="font-mono text-fg-dim text-xs">
      <span className={`mr-2 ${BAND_COLOR[band]}`}>●</span>
      {isStreaming ? "Routing" : "Routed"}
      {tool ? ` to ${tool}` : ""} ({BAND_LABEL[band]}
      {pct ? `, ${pct}` : ""}){isStreaming ? "…" : ""}
    </div>
  );
}
