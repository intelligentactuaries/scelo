// Inline chart in an assistant message. Lazily fetches /charts/{spec_id}
// and renders via the existing <EChart>. Multiple chart_spec_ids on a
// tool_result render as a stacked column.

import { EChart } from "@/components/EChart";
import { type ChartSpec, api } from "@/lib/api";
import { useEffect, useState } from "react";

type Props = {
  specId: string;
};

type Status =
  | { kind: "loading" }
  | { kind: "ready"; spec: ChartSpec }
  | { kind: "error"; message: string };

export function ChartBlock({ specId }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "loading" });
    api.getChart(specId).then((r) => {
      if (cancelled) return;
      if (r.ok) setStatus({ kind: "ready", spec: r.value });
      else setStatus({ kind: "error", message: r.error.message });
    });
    return () => {
      cancelled = true;
    };
  }, [specId]);

  const isHeatmap = status.kind === "ready" && /heatmap|surface|improvement/i.test(status.spec.$id);
  return (
    <figure className="border border-border bg-bg-1">
      <figcaption className="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5 text-[11px]">
        <span
          className="truncate text-fg"
          title={status.kind === "ready" ? status.spec.title : specId}
        >
          {status.kind === "ready" ? status.spec.title : specId}
        </span>
        <span className="shrink-0 font-mono text-fg-dim">
          {status.kind === "ready" ? `${specId} · ${status.spec.data_hash.slice(7, 19)}` : specId}
        </span>
      </figcaption>
      <div className={`${isHeatmap ? "h-[460px]" : "h-[400px]"} p-2`}>
        {status.kind === "loading" && (
          <div className="flex h-full items-center justify-center text-fg-dim text-xs">
            loading chart…
          </div>
        )}
        {status.kind === "error" && (
          <div className="flex h-full items-center justify-center text-error text-xs">
            could not load chart · {status.message}
          </div>
        )}
        {status.kind === "ready" && <EChart spec={status.spec} className="h-full w-full" />}
      </div>
      {status.kind === "ready" && status.spec.description && (
        <div className="border-t border-border px-3 py-1.5 text-fg-dim text-[11px]">
          {status.spec.description}
        </div>
      )}
    </figure>
  );
}
