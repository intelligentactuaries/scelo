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
import {
  SAMPLE_OPTIONS_LIST,
  type SampleKey,
  SoftDataWorkstation,
} from "@/components/Scelo/SoftDataWorkstation";
import { ToolsWorkstation } from "@/components/Scelo/ToolsWorkstation";
import { SceloProvider, useScelo } from "@/components/Scelo/sceloContext";
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
  // `.scelo-app` lets theme.css hold SN Pro over the inline font styles the
  // canvas and chart libraries set inside this subtree.
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
    modelWires,
  } = useScelo();
  // Read after the async imports below: the provider wires a fresh pick in
  // an effect that lands after this component's.
  const modelWiresRef = useRef(modelWires);
  modelWiresRef.current = modelWires;
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
      const { dataSignature, heuristicPick, finalizePick } = await import(
        "@/components/Scelo/modelPicker"
      );
      const { summariseDataset } = await import("@/components/Scelo/SoftDataWorkstation");
      const metas = summariseDataset(dataset);
      const sig = dataSignature(dataset, metas);
      const pick = finalizePick(heuristicPick(sig), dataset);
      setDomain(pick.domain);
      setSelectedModels(
        pick.selected.map((s) => ({
          id: s.id,
          enabled: !s.disabled,
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
      const { pipelinePlan } = await import("@/components/Scelo/pipeline");
      const next: Record<string, ReturnType<typeof runModel>> = {};
      // Same plan as Hard Data: wire sources first, their results handed on.
      const enabled = selectedModels.filter((m) => m.enabled).map((m) => m.id);
      const plan = pipelinePlan(enabled, modelWiresRef.current);
      for (const id of plan.order) {
        const upstream = new Map(
          (plan.upstreamOf.get(id) ?? [])
            .filter((src) => next[src])
            .map((src) => [src, next[src]] as const),
        );
        try {
          next[id] = runModel(id, dataset, upstream);
        } catch (e) {
          // Surface the offending model + error to the console so the
          // debug screenshot has something to grep on. The runner already
          // catches most failures itself; this is the belt-and-braces
          // path for runtime exceptions in the runner dispatch.
          console.error("[autorun] model", id, "threw:", e);
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
  const [visited, setVisited] = useState<Set<typeof stage>>(() => new Set([stage]));
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
    // ia-view-in replays each time the stage is shown again (display:none →
    // block restarts CSS animations), so every stage switch fades up.
    <div
      className="ia-view-in absolute inset-0 overflow-auto"
      style={{ display: active ? "block" : "none" }}
      aria-hidden={!active}
    >
      {children}
    </div>
  );
}

function MacroStage() {
  // The pipeline canvas is the whole stage: its bar carries the project,
  // workspace and session actions.
  return <SceloFlow className="h-full w-full" />;
}
