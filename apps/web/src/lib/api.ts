// Typed FastAPI client. Uses Vite's /api proxy in dev (rewrites to :8000); in
// production the base is read from VITE_API_URL.

const ENV_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "");
const BASE = ENV_BASE && ENV_BASE.length > 0 ? ENV_BASE : "/api";

export const API_BASE = BASE;

// ── Result type ──────────────────────────────────────────────────────────────

export type ApiError = {
  status: number; // 0 for network/parse errors
  code: string;
  message: string;
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export const Ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const Err = <T>(error: ApiError): Result<T> => ({ ok: false, error });

// ── core fetch helpers ───────────────────────────────────────────────────────

async function readError(resp: Response, path: string): Promise<ApiError> {
  let message = `${resp.status} ${resp.statusText} on ${path}`;
  try {
    const body = await resp.json();
    if (body && typeof body === "object" && "detail" in body) {
      message = String((body as { detail: unknown }).detail);
    }
  } catch {
    // body wasn't json — keep the default message
  }
  return { status: resp.status, code: `http_${resp.status}`, message };
}

async function getJson<T>(path: string): Promise<Result<T>> {
  try {
    const resp = await fetch(`${BASE}${path}`);
    if (!resp.ok) return Err(await readError(resp, path));
    return Ok((await resp.json()) as T);
  } catch (e: unknown) {
    return Err({ status: 0, code: "network_error", message: String(e) });
  }
}

async function getText(path: string): Promise<Result<string>> {
  try {
    const resp = await fetch(`${BASE}${path}`);
    if (!resp.ok) return Err(await readError(resp, path));
    return Ok(await resp.text());
  } catch (e: unknown) {
    return Err({ status: 0, code: "network_error", message: String(e) });
  }
}

async function postJson<T>(path: string, body: unknown): Promise<Result<T>> {
  try {
    const resp = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return Err(await readError(resp, path));
    return Ok((await resp.json()) as T);
  } catch (e: unknown) {
    return Err({ status: 0, code: "network_error", message: String(e) });
  }
}

// ── domain types ─────────────────────────────────────────────────────────────

export type AgentSummary = { name: string; description: string };

export type ChartSpec = {
  $id: string;
  $version: 1;
  title: string;
  description?: string;
  data_hash: string;
  option: Record<string, unknown>;
};

export type FlowNode = {
  id: string;
  type: "agent" | "tool" | "data" | "treaty" | "rule" | "step";
  label: string;
  data?: Record<string, unknown>;
  position?: { x: number; y: number };
  status?: "idle" | "running" | "blocked" | "done" | "error";
};

export type FlowEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  animated?: boolean;
};

export type FlowGraphSpec = {
  $id: string;
  $version: 1;
  title: string;
  layout?: "horizontal" | "vertical" | "radial" | "force";
  nodes: FlowNode[];
  edges: FlowEdge[];
};

// ── Reserving slice types ────────────────────────────────────────────────────

export type Triangle = {
  origin_years: number[];
  dev_periods: number[];
  values: (number | null)[][];
  currency?: string;
  basis?: "accident" | "reporting";
};

export type MackResult = {
  ibnr_total: number;
  ibnr_by_origin: Record<string, number>;
  // Populated only when the R `ChainLadder` engine produced this run; the
  // Python fallback returns nulls (point estimate without variance).
  mse: number | null;
  standard_error: number | null;
  cv: number | null;
};

export type BootstrapResult = {
  total_distribution: Record<string, number>;
  by_origin_distributions: Record<string, Record<string, number>>;
  n_sims: number;
  seed: number;
};

export type ReservingPrediction = {
  mack: MackResult;
  bootstrap: BootstrapResult | null;
  chart_spec_ids: string[];
  engine: "r" | "python_fallback";
  computed_at: string;
};

export type Scenario =
  | { kind: "tail_factor"; name: string; description?: string; adjustment_pct: number }
  | { kind: "exclude_origin"; name: string; description?: string; year: number };

// ── orchestrator chat ────────────────────────────────────────────────────────

export type OrchestratorMessage = { role: "user" | "assistant"; content: string };

// Wire-format payloads — match what the orchestrator actually emits in
// packages/ia-agents/ia_agents/orchestrator.py. Fields not used by the
// chat-first UI are deliberately preserved as `unknown`s on the event.
export type OrchestratorEvent =
  | { kind: "thinking"; payload: { text: string } }
  | {
      kind: "routing";
      payload: {
        confidence?: number;
        confidence_band?: "high" | "medium" | "low";
        dispatched_tool?: string | null;
        llm_consulted?: boolean;
        rule_top3?: unknown[];
      };
    }
  | {
      kind: "wiki_retrieval";
      payload: {
        entries?: Array<{ id: string; title: string; score?: number }>;
        mode?: string;
        k?: number;
      };
    }
  | {
      kind: "regulatory_retrieval";
      payload: {
        entries?: Array<{ id: string; title: string; regulator?: string; score?: number }>;
        mode?: string;
        k?: number;
      };
    }
  | { kind: "tool_call"; payload: { tool: string; arguments: Record<string, unknown> } }
  | {
      kind: "tool_result";
      payload: {
        tool: string;
        output: unknown;
        duration_ms?: number;
      };
    }
  | { kind: "message"; payload: { text: string } }
  | {
      kind: "usage";
      payload: {
        provider?: string;
        input_tokens?: number;
        output_tokens?: number;
      };
    }
  | { kind: "error"; payload: { code?: string; message: string; reconnect?: boolean } }
  | { kind: "done"; payload: { routing_engine: "openrouter" | "rule_based" | string } };

// ── CSV parsing (shared between drag-drop and sample loading) ────────────────

export function parseTriangleCsv(text: string): Triangle {
  const rows = text
    .split(/\r?\n/)
    .map((r) => r.split(","))
    .filter((r) => r.length > 1 && r.some((c) => c.trim() !== ""));
  if (rows.length < 2) throw new Error("CSV must have header + at least one row");
  const header = rows[0];
  if (header[0].trim().toLowerCase() !== "origin") {
    throw new Error("first column must be 'origin'");
  }
  const dev_periods = header.slice(1).map((d) => Number.parseInt(d, 10));
  const origin_years: number[] = [];
  const values: (number | null)[][] = [];
  for (const r of rows.slice(1)) {
    origin_years.push(Number.parseInt(r[0], 10));
    const row: (number | null)[] = [];
    for (const cell of r.slice(1)) {
      const t = cell.trim();
      row.push(t === "" ? null : Number.parseFloat(t));
    }
    while (row.length < dev_periods.length) row.push(null);
    values.push(row);
  }
  return { origin_years, dev_periods, values, currency: "USD", basis: "accident" };
}

// ── file classifier ──────────────────────────────────────────────────────────

export type FileClassification = {
  specialist:
    | "reserving"
    | "mortality"
    | "pensions"
    | "pricing"
    | "climate"
    | "capital"
    | "regulatory"
    | "documentation"
    | "unknown";
  confidence: number;
  reasoning: string;
  suggested_capability: "predict" | "simulate" | "advise" | "explain";
  saved_path: string;
  bytes: number;
  filename: string;
};

export async function classifyFile(
  conversationId: string,
  file: File,
): Promise<Result<FileClassification>> {
  try {
    const fd = new FormData();
    fd.append("conversation_id", conversationId);
    fd.append("file", file);
    const resp = await fetch(`${BASE}/files/classify`, { method: "POST", body: fd });
    if (!resp.ok) return Err(await readError(resp, "/files/classify"));
    return Ok((await resp.json()) as FileClassification);
  } catch (e: unknown) {
    return Err({ status: 0, code: "network_error", message: String(e) });
  }
}

// ── high-level API surface (Result-shaped) ───────────────────────────────────

export const api = {
  health: () => getJson<{ status: string; version: string }>("/health"),
  listAgents: () => getJson<AgentSummary[]>("/agents"),
  listCharts: () => getJson<string[]>("/charts"),
  getChart: (id: string) => getJson<ChartSpec>(`/charts/${id}`),
  listGraphs: () => getJson<string[]>("/graphs"),
  getGraph: (id: string) => getJson<FlowGraphSpec>(`/graphs/${id}`),
  listRuns: () => getJson<Array<Record<string, unknown>>>("/runs"),

  // Reserving — the typed POST + sample routes.
  loadSample: async (name: string): Promise<Result<Triangle>> => {
    const csv = await getText(`/samples/${encodeURIComponent(name)}`);
    if (!csv.ok) return csv;
    try {
      return Ok(parseTriangleCsv(csv.value));
    } catch (e) {
      return Err({ status: 0, code: "parse_error", message: String(e) });
    }
  },
  invokeReserving: <T = unknown>(
    capability: "predict" | "simulate" | "advise" | "explain" | "compare_to_foundation_baseline",
    input: Record<string, unknown>,
  ) => postJson<T>("/agents/reserving/invoke", { capability, ...input }),
  getRunoffHeatmap: (triangle: Triangle, mack: MackResult) =>
    postJson<ChartSpec>("/charts/runoff_heatmap", { triangle, mack }),
  getUltimateFan: (bootstrap: BootstrapResult) =>
    postJson<ChartSpec>("/charts/ultimate_fan", { bootstrap }),
};

// ── SSE streaming helper for /agents/reserving/invoke?capability=simulate ────

export type ScenarioResult = {
  scenario: string;
  prediction: ReservingPrediction;
};

export async function streamReservingSimulate(
  triangle: Triangle,
  scenarios: Scenario[],
  callbacks: {
    onScenario?: (r: ScenarioResult) => void;
    onComplete?: (n: number) => void;
    onError?: (e: ApiError) => void;
  },
  opts?: { signal?: AbortSignal; n_sims?: number; seed?: number },
): Promise<void> {
  try {
    const resp = await fetch(`${BASE}/agents/reserving/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        capability: "simulate",
        triangle,
        scenarios,
        n_sims: opts?.n_sims ?? 999,
        seed: opts?.seed ?? 42,
      }),
      signal: opts?.signal,
    });
    if (!resp.ok || !resp.body) {
      callbacks.onError?.(await readError(resp, "/agents/reserving/invoke"));
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // sse-starlette emits CRLF terminators; normalise to LF so a single
      // `indexOf("\n\n")` finds the frame boundary regardless of source.
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        idx = buffer.indexOf("\n\n");
        let event = "message";
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        try {
          const parsed = JSON.parse(dataLines.join("\n"));
          if (event === "scenario_result") callbacks.onScenario?.(parsed as ScenarioResult);
          else if (event === "run_completed") callbacks.onComplete?.((parsed as { n: number }).n);
        } catch (e) {
          callbacks.onError?.({
            status: 0,
            code: "parse_error",
            message: `bad SSE frame: ${String(e)}`,
          });
        }
      }
    }
  } catch (e: unknown) {
    callbacks.onError?.({ status: 0, code: "network_error", message: String(e) });
  }
}

// ── orchestrator stream helper ───────────────────────────────────────────────

export async function streamOrchestrator(
  query: string,
  history: OrchestratorMessage[],
  callbacks: {
    onEvent?: (e: OrchestratorEvent) => void;
    onError?: (e: ApiError) => void;
  },
  opts?: { signal?: AbortSignal },
): Promise<void> {
  try {
    // Lazy-import so the chat path doesn't pull the aiProviders module on
    // every render. The headers are empty when the user is on Ollama
    // (the default), so the backend uses its process-wide orchestrator.
    const { activeProviderHeaders } = await import("./aiProviders");
    const providerHeaders = await activeProviderHeaders();
    const resp = await fetch(`${BASE}/agents/orchestrator/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...providerHeaders,
      },
      body: JSON.stringify({ query, history }),
      signal: opts?.signal,
    });
    if (!resp.ok || !resp.body) {
      callbacks.onError?.(await readError(resp, "/agents/orchestrator/stream"));
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // sse-starlette emits CRLF terminators; normalise to LF so a single
      // `indexOf("\n\n")` finds the frame boundary regardless of source.
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        idx = buffer.indexOf("\n\n");
        let event = "message";
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        try {
          const payload = JSON.parse(dataLines.join("\n"));
          callbacks.onEvent?.({ kind: event, payload } as OrchestratorEvent);
        } catch (e) {
          callbacks.onError?.({
            status: 0,
            code: "parse_error",
            message: `bad SSE frame: ${String(e)}`,
          });
        }
      }
    }
  } catch (e: unknown) {
    callbacks.onError?.({ status: 0, code: "network_error", message: String(e) });
  }
}
