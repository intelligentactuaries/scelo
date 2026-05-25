// Scelo — the macro view of the AI system's "brain".
//
// Data philosophy: soft data → tools → hard data. Soft data is what we cannot
// see / cannot easily decide on (the temperature of the room). Tools are the
// statistical & actuarial models that convert it (the thermometer). Hard data
// is the readable, decision-grade output (24°C).
//
// Sub-paths are owned here so each macro node can drill into a full-screen
// workstation without unmounting the rest of the dashboards shell.
//
// SceloProvider wraps the whole tree so dataset + filters + model picks
// survive flipping between sub-routes — the user loads data once in Soft Data
// and Tools / Hard read it from the shared context.

import { HardDataWorkstation } from "@/components/Scelo/HardDataWorkstation";
import { SceloFlow } from "@/components/Scelo/SceloFlow";
import { SceloLogo } from "@/components/Scelo/SceloLogo";
import {
  clearSceloSession,
  SceloProvider,
  useScelo,
} from "@/components/Scelo/sceloContext";
import {
  SAMPLE_OPTIONS_LIST,
  type SampleKey,
  SoftDataWorkstation,
} from "@/components/Scelo/SoftDataWorkstation";
import { ToolsWorkstation } from "@/components/Scelo/ToolsWorkstation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

function activeStage(pathname: string): "macro" | "soft" | "tools" | "hard" {
  const sub = pathname.replace(/^\/dashboards\/scelo\/?/, "").replace(/\/$/, "");
  if (sub === "soft") return "soft";
  if (sub === "tools") return "tools";
  if (sub === "hard") return "hard";
  return "macro";
}

export default function Scelo() {
  // `.scelo-app` scopes the SN Pro font override (theme.css) to this subtree
  // only — the rest of /dashboards keeps Inter / Fraunces / JetBrains Mono.
  return (
    <SceloProvider>
      <div className="scelo-app h-full">
        <SceloBootstrap />
        <SceloRoutes />
      </div>
    </SceloProvider>
  );
}

// Read `?sample=<key>` once on mount and load the named sample into
// SceloContext. Works from any sub-route (soft / tools / hard / macro),
// so `?sample=lifelib-mp` lands the user on the chosen page with the
// dataset already populated — useful for shareable demo links and for
// debugging the Tools → Hard pipeline without manually navigating Soft.
function SceloBootstrap() {
  const {
    dataset,
    setDataset,
    selectedModels,
    setSelectedModels,
    setDomain,
    runs,
    setRuns,
  } = useScelo();
  const fired = useRef(false);
  const ranPicks = useRef(false);
  const ranAutorun = useRef(false);

  // 1. `?sample=<key>` — load the named sample into context.
  useEffect(() => {
    if (fired.current || dataset) return;
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    const key = sp.get("sample") as SampleKey | null;
    if (!key) return;
    const opt = SAMPLE_OPTIONS_LIST().find((o) => o.key === key);
    if (!opt) return;
    fired.current = true;
    setDataset(opt.build());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. `?autopick=1` — once a dataset is loaded, run the heuristic picker
  // and seed `selectedModels`. Skips the LLM call entirely (deterministic /
  // headless friendly). For end-to-end debug flows.
  useEffect(() => {
    if (ranPicks.current || !dataset || selectedModels.length > 0) return;
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("autopick") !== "1" && sp.get("autorun") !== "1") return;
    ranPicks.current = true;
    void (async () => {
      const { dataSignature, heuristicPick } = await import(
        "@/components/Scelo/modelPicker"
      );
      const { summariseDataset } = await import(
        "@/components/Scelo/SoftDataWorkstation"
      );
      const metas = summariseDataset(dataset);
      const sig = dataSignature(dataset, metas);
      const pick = heuristicPick(sig);
      setDomain(pick.domain);
      setSelectedModels(
        pick.selected.map((s) => ({
          id: s.id,
          enabled: true,
          source: "ai",
          rationale: s.rationale,
        })),
      );
    })();
  }, [dataset, selectedModels.length, setDomain, setSelectedModels]);

  // 3. `?autorun=1` — run every enabled selected model and store results.
  useEffect(() => {
    if (ranAutorun.current || !dataset) return;
    if (selectedModels.length === 0) return;
    if (Object.keys(runs).length > 0) return;
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("autorun") !== "1") return;
    ranAutorun.current = true;
    void (async () => {
      const { runModel } = await import("@/components/Scelo/modelRunner");
      const next: Record<string, ReturnType<typeof runModel>> = {};
      for (const m of selectedModels) {
        if (!m.enabled) continue;
        try {
          next[m.id] = runModel(m.id, dataset);
        } catch (e) {
          // Surface the offending model + error to the console so the
          // debug screenshot has something to grep on. The runner already
          // catches most failures itself; this is the belt-and-braces
          // path for runtime exceptions in the runner dispatch.
          console.error("[autorun] model", m.id, "threw:", e);
        }
      }
      setRuns(next);
    })();
  }, [dataset, selectedModels, runs, setRuns]);

  return null;
}

function SceloRoutes() {
  const { pathname } = useLocation();
  const stage = activeStage(pathname);

  // Lazy-mount + keep-alive : each stage is mounted the first time
  // the user visits it, then stays mounted (hidden via display:none)
  // until /dashboards/scelo itself unmounts. Without this, every
  // sub-route flip would unmount the previous workstation and lose
  // its local state — model picks gone, derived columns gone, panel
  // expansions gone, etc.
  //
  // Tracked client-side in state (not a ref) so a re-render fires
  // when a new stage joins the visited set : otherwise the freshly-
  // mounted workstation wouldn't paint until the next render trigger.
  const [visited, setVisited] = useState<Set<typeof stage>>(
    () => new Set([stage]),
  );
  useEffect(() => {
    setVisited((prev) => (prev.has(stage) ? prev : new Set(prev).add(stage)));
  }, [stage]);

  return (
    <div className="relative h-full">
      <Pane active={stage === "macro"} visited={visited.has("macro")}>
        <MacroStage />
      </Pane>
      <Pane active={stage === "soft"} visited={visited.has("soft")}>
        <SoftDataWorkstation />
      </Pane>
      <Pane active={stage === "tools"} visited={visited.has("tools")}>
        <ToolsWorkstation />
      </Pane>
      <Pane active={stage === "hard"} visited={visited.has("hard")}>
        <HardDataWorkstation />
      </Pane>
    </div>
  );
}

function Pane({
  active,
  visited,
  children,
}: {
  active: boolean;
  visited: boolean;
  children: ReactNode;
}) {
  // Stay unmounted until the user first visits the stage : avoids
  // firing the heavier workstations' mount-time effects until needed.
  if (!visited) return null;
  return (
    <div
      className="absolute inset-0 overflow-auto"
      style={{ display: active ? "block" : "none" }}
      aria-hidden={!active}
    >
      {children}
    </div>
  );
}

function MacroStage() {
  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-border px-6 py-5">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <div className="eyebrow mb-2 flex items-center gap-2">
              <SceloLogo className="h-5 w-5 text-fg-mute" />
              <span>Scelo · brain layer</span>
            </div>
            <h1 className="display text-fg text-[clamp(1.4rem,1.9vw,1.9rem)] max-w-[40ch]">
              Soft data → Tools → Hard data.
            </h1>
          </div>
          <ResetSceloButton />
        </div>
        <p className="mt-3 max-w-[78ch] text-[13.5px] leading-[1.55] text-fg-mute">
          The macro view of the AI system's reasoning fabric. Each stage carries its own scoped
          chatbot; click the expand icon on a node to drill into its workstation.
        </p>
      </header>
      <div className="min-h-0 flex-1">
        <SceloFlow className="h-full w-full" />
      </div>
    </div>
  );
}

/** Explicit "wipe the working session" affordance. The session
 *  auto-persists everything (dataset, filters, model picks, runs,
 *  derived columns, events) across route navigation + reloads; this
 *  is the ONLY thing that drops it. Confirmation modal lives inline
 *  to keep the action one click away from the macro view. */
function ResetSceloButton() {
  const {
    setDataset,
    setFilters,
    setSelectedModels,
    setDomain,
    setPickSummary,
    setRuns,
    setDerivedColumns,
    setTransformLog,
    clearEvents,
  } = useScelo();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        title="Wipe dataset, filters, model picks, runs, derived columns, and the activity log."
        className="ia-btn ia-btn-md ia-btn-danger shrink-0"
      >
        reset session
      </button>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-2 rounded border border-error/60 bg-error/5 px-3 py-1.5 text-xs">
      <span className="text-fg">Wipe all Scelo work?</span>
      <button
        type="button"
        onClick={() => {
          setDataset(null);
          setFilters([]);
          setSelectedModels([]);
          setDomain(null);
          setPickSummary(null);
          setRuns({});
          setDerivedColumns({});
          setTransformLog(new Set());
          clearEvents();
          clearSceloSession();
          setConfirming(false);
        }}
        className="ia-btn ia-btn-sm ia-btn-primary border-error bg-error"
      >
        yes, reset
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="ia-btn ia-btn-sm ia-btn-ghost"
      >
        cancel
      </button>
    </div>
  );
}
