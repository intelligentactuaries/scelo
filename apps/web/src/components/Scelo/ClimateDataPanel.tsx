// Renders the climate-data lineage section inside the Hard Data model
// detail dashboard for climate-family runs (CLIMADA, parametric-design).
// Three reanalyses are introduced as a typed registry (`climateDataSources`),
// the canonical actuarial pipeline maps each peril to its primary +
// cross-check sources, and a preview chart shows the daily 2 m air
// temperature and total precipitation for a Pretoria grid-cell across all
// three reanalyses so the user can see the ensemble agreement-and-spread.

import { useTheme } from "@/lib/theme";
import ReactECharts from "echarts-for-react";
import { LineChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useMemo } from "react";
import { CLIMATE_DATA_SOURCES, CLIMATE_PIPELINE } from "./climateDataSources";
import {
  CLIMATE_SAMPLE,
  CLIMATE_SAMPLE_META,
  type ClimateSampleRow,
  ensembleStats,
} from "./climateSampleData";

echarts.use([
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  MarkLineComponent,
  LineChart,
  CanvasRenderer,
]);

// Light/dark colour overrides that work with the rest of Scelo's accent
// palette. Each reanalysis gets its own stable colour so the three lines
// remain visually consistent across panels (temperature + precipitation).
function useEnsembleColours() {
  const { resolved } = useTheme();
  const dark = resolved !== "light";
  return {
    era5: dark ? "#00d68f" : "#009669", // primary
    merra2: dark ? "#7aa2f7" : "#3760cc", // accent-2
    jra3q: dark ? "#ff9b6b" : "#c45a2e", // accent (warm)
    fg: dark ? "#e8e8e8" : "#181818",
    fgMute: dark ? "#9a9a9a" : "#5c5c5a",
    border: dark ? "#2a2a2a" : "#dcdad5",
    bg: dark ? "#141414" : "#ffffff",
  };
}

function EnsembleChart({
  rows,
  field,
  yLabel,
  unit,
}: {
  rows: ClimateSampleRow[];
  field: "t2m" | "pr";
  yLabel: string;
  unit: string;
}) {
  const c = useEnsembleColours();
  const dates = rows.map((r) => r.date.slice(5)); // MM-DD
  const era5 = rows.map((r) => (field === "t2m" ? r.t2m_era5 : r.pr_era5));
  const merra2 = rows.map((r) => (field === "t2m" ? r.t2m_merra2 : r.pr_merra2));
  const jra3q = rows.map((r) => (field === "t2m" ? r.t2m_jra3q : r.pr_jra3q));

  const option = useMemo(
    () => ({
      animation: false,
      grid: { top: 28, bottom: 36, left: 48, right: 16 },
      legend: {
        top: 0,
        right: 0,
        textStyle: { color: c.fgMute, fontSize: 10 },
        icon: "roundRect",
        itemWidth: 10,
        itemHeight: 6,
      },
      tooltip: {
        trigger: "axis",
        backgroundColor: c.bg,
        borderColor: c.border,
        textStyle: { color: c.fg, fontSize: 11 },
        valueFormatter: (v: number) => `${v.toFixed(1)} ${unit}`,
      },
      xAxis: {
        type: "category",
        data: dates,
        axisLabel: { color: c.fgMute, fontSize: 9, interval: 4 },
        axisLine: { lineStyle: { color: c.border } },
      },
      yAxis: {
        type: "value",
        name: yLabel,
        nameTextStyle: { color: c.fgMute, fontSize: 9 },
        axisLabel: { color: c.fgMute, fontSize: 9 },
        splitLine: { lineStyle: { color: c.border } },
      },
      series: [
        {
          name: "ERA5",
          type: "line",
          data: era5,
          smooth: 0.2,
          showSymbol: false,
          lineStyle: { color: c.era5, width: 2 },
        },
        {
          name: "MERRA-2",
          type: "line",
          data: merra2,
          smooth: 0.2,
          showSymbol: false,
          lineStyle: { color: c.merra2, width: 1.5, type: "dashed" },
        },
        {
          name: "JRA-3Q",
          type: "line",
          data: jra3q,
          smooth: 0.2,
          showSymbol: false,
          lineStyle: { color: c.jra3q, width: 1.5, type: "dotted" },
        },
      ],
    }),
    [c, dates, era5, merra2, jra3q, yLabel, unit],
  );

  return (
    <ReactECharts
      echarts={echarts}
      option={option}
      notMerge
      lazyUpdate
      style={{ height: 200, width: "100%" }}
    />
  );
}

function SourceCard({ source }: { source: (typeof CLIMATE_DATA_SOURCES)[number] }) {
  const c = useEnsembleColours();
  const accent =
    source.id === "era5" || source.id === "era5_land"
      ? c.era5
      : source.id === "merra2"
        ? c.merra2
        : c.jra3q;
  return (
    <div
      className="rounded-2xl border border-border bg-bg-1 p-4"
      style={{ borderLeftColor: accent, borderLeftWidth: 3 }}
    >
      <div
        className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em]"
        style={{ color: accent }}
      >
        <span
          aria-hidden
          className="inline-block h-1 w-1 rounded-full"
          style={{ background: accent, opacity: 0.7 }}
        />
        <span>{source.role}</span>
      </div>
      <h4 className="mt-2 text-base font-medium text-fg">{source.name}</h4>
      <p className="mt-0.5 text-[11px] text-fg-mute">{source.producer}</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10px] text-fg-dim">
        <dt>spatial</dt>
        <dd className="text-fg-mute">{source.resolution_spatial}</dd>
        <dt>temporal</dt>
        <dd className="text-fg-mute">{source.resolution_temporal}</dd>
        <dt>coverage</dt>
        <dd className="text-fg-mute">
          {source.coverage_start}–{source.coverage_end ?? "present"}
        </dd>
        <dt>license</dt>
        <dd className="text-fg-mute">{source.license}</dd>
      </dl>
      <details className="mt-3">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-fg-dim hover:text-fg-mute">
          access & variables
        </summary>
        <div className="mt-2 space-y-2 text-[11px]">
          <ul className="space-y-1.5">
            {source.access.map((a) => (
              <li key={a.url} className="text-fg-mute">
                <a
                  href={a.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-mono text-[10px] text-fg hover:text-primary"
                >
                  {a.channel} ↗
                </a>
                <span className="ml-1 text-fg-dim">— {a.note}</span>
              </li>
            ))}
          </ul>
          <div className="font-mono text-[10px] text-fg-dim">
            variables: {source.variables.slice(0, 5).join(" · ")}
            {source.variables.length > 5 ? " · …" : ""}
          </div>
        </div>
      </details>
      <details className="mt-2">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-fg-dim hover:text-fg-mute">
          actuarial use & caveats
        </summary>
        <div className="mt-2 space-y-1 text-[11px]">
          <ul className="ml-3 list-disc text-fg-mute">
            {source.use_cases.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
          <ul className="ml-3 list-disc text-fg-dim">
            {source.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}

export function ClimateDataPanel({ modelId }: { modelId: string }) {
  // The peril↔reanalysis mapping is centralised in `CLIMATE_PIPELINE` —
  // pick the row that's most appropriate for the model on screen. For
  // CLIMADA the canonical primary is TC; for parametric design we lean on
  // the heatwave / drought example since those are the most common
  // products in market today.
  const pipelineRow =
    modelId === "climada"
      ? CLIMATE_PIPELINE.find((p) => p.workflow.startsWith("TC"))
      : CLIMATE_PIPELINE.find((p) => p.workflow.startsWith("Heatwave"));

  // Ensemble stats over the sample window — the temperature column is
  // the easiest to interpret at a glance.
  const tStats = useMemo(
    () =>
      ensembleStats([
        ...CLIMATE_SAMPLE.map((r) => r.t2m_era5),
        ...CLIMATE_SAMPLE.map((r) => r.t2m_merra2),
        ...CLIMATE_SAMPLE.map((r) => r.t2m_jra3q),
      ]),
    [],
  );

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[12px] leading-relaxed text-fg-mute">
          Atmospheric reanalyses turn historical observations into globally complete, physically
          consistent gridded records. Scelo uses three independent reanalyses as an ensemble so the
          disagreement between them gives an actuarially honest bound on reanalysis uncertainty —
          even where no ground-truth station record exists.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {CLIMATE_DATA_SOURCES.map((s) => (
          <SourceCard key={s.id} source={s} />
        ))}
      </div>

      {/* canonical pipeline mapping */}
      {pipelineRow && (
        <div className="rounded-2xl border border-border bg-bg-1 p-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-dim">
            canonical pipeline · {pipelineRow.workflow}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
            <span className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-primary">
              primary: {pipelineRow.primary}
            </span>
            <span className="text-fg-dim">→</span>
            <span className="text-fg-mute">cross-check: {pipelineRow.cross_check.join(" · ")}</span>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-fg-mute">{pipelineRow.notes}</p>
        </div>
      )}

      {/* sample preview */}
      <div>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h4 className="text-sm font-medium text-fg">Example reanalysis output</h4>
          <p className="font-mono text-[10px] text-fg-dim">
            {CLIMATE_SAMPLE_META.location} · ({CLIMATE_SAMPLE_META.lat.toFixed(2)},{" "}
            {CLIMATE_SAMPLE_META.lon.toFixed(2)}) · {CLIMATE_SAMPLE_META.window}
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="rounded-2xl border border-border bg-bg-1 p-4">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-fg-dim">
              2 m air temperature · daily mean
            </div>
            <EnsembleChart rows={CLIMATE_SAMPLE} field="t2m" yLabel="°C" unit="°C" />
            <div className="mt-2 font-mono text-[10px] text-fg-dim">
              ensemble mean {tStats.mean.toFixed(1)} °C · range {tStats.range.toFixed(1)} °C · CV{" "}
              {tStats.cv_pct.toFixed(1)}%
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-bg-1 p-4">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-fg-dim">
              total precipitation · daily sum
            </div>
            <EnsembleChart rows={CLIMATE_SAMPLE} field="pr" yLabel="mm" unit="mm" />
            <div className="mt-2 font-mono text-[10px] text-fg-dim">
              precipitation disagreement is the loudest signal — sub-grid convection isn't well
              parameterised in any of the three reanalyses
            </div>
          </div>
        </div>
        <p className="mt-3 text-[11px] italic text-fg-dim">{CLIMATE_SAMPLE_META.note}</p>
      </div>
    </div>
  );
}

// Helper used by the workstation to decide whether to render the panel.
export function isClimateFamilyModel(modelId: string): boolean {
  return modelId === "climada" || modelId === "parametric-design";
}
