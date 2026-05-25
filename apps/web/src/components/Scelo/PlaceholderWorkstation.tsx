// Drill-in stand-in for the Tools / Hard Data stages until those workstations
// are fleshed out. The expand affordance on every macro node is consistent;
// only Soft Data currently has a real workstation behind it.

import { useNavigate } from "react-router-dom";
import type { SceloStage } from "./SceloNode";

type Props = {
  stage: Exclude<SceloStage, "soft">;
  title: string;
  subtitle: string;
};

export function PlaceholderWorkstation({ stage, title, subtitle }: Props) {
  const navigate = useNavigate();
  const accent = stage === "tools" ? "text-primary" : "text-accent-3";

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-bg-1 px-4 py-2">
        <button
          type="button"
          onClick={() => navigate("/dashboards/scelo")}
          className="font-mono text-xs text-fg-mute hover:text-primary"
        >
          ← macro view
        </button>
        <div className="h-4 w-px bg-border" />
        <div className="min-w-0">
          <div className={`font-mono text-[10px] uppercase tracking-wider ${accent}`}>
            {stage === "tools" ? "02 · tools" : "03 · hard data"}
          </div>
          <h1 className="text-sm text-fg">{title}</h1>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className={`mb-3 font-mono text-xs uppercase tracking-wider ${accent}`}>
            workstation · pending
          </div>
          <p className="text-sm text-fg-mute">{subtitle}</p>
          <p className="mt-3 text-xs text-fg-dim">
            This drill-in is the next layer to build out. Soft Data lands first; Tools and Hard Data
            follow once the soft-side intake and validation flows feel right.
          </p>
        </div>
      </div>
    </div>
  );
}
