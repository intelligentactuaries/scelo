import type {
  CanonWork,
  CouncilAgentResult,
  GroupJustificationResponse,
  Intervention,
  JustificationResponse,
  ProviderPrefs,
  ProvidersInfo,
  Run,
  RunSummary,
  RunWmtr,
  SocietyParams,
} from '../../shared/types';
import type { WmtrSingleParams } from '../../shared/wmtr';
import type { LegalJurisdiction } from '../../shared/constants';

export type CloudProvider = 'anthropic' | 'openai' | 'gemini' | 'hf';

const LS_KEY = 'swarm-council:keys:v1';
const LS_JUR_KEY = 'swarm-council:jurisdiction:v1';
const DEFAULT_JUR: LegalJurisdiction = 'ZA';

export type StoredKeys = Partial<Record<CloudProvider, string>>;

export function loadKeys(): StoredKeys {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as StoredKeys;
  } catch {
    return {};
  }
}

export function saveKeys(keys: StoredKeys): void {
  localStorage.setItem(LS_KEY, JSON.stringify(keys));
}

export function loadJurisdiction(): LegalJurisdiction {
  try {
    const raw = localStorage.getItem(LS_JUR_KEY);
    if (!raw) return DEFAULT_JUR;
    if (['ZA', 'US', 'UK', 'EU'].includes(raw)) return raw as LegalJurisdiction;
    return DEFAULT_JUR;
  } catch {
    return DEFAULT_JUR;
  }
}

export function saveJurisdiction(j: LegalJurisdiction): void {
  localStorage.setItem(LS_JUR_KEY, j);
}

async function jfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  if (!r.ok) {
    let msg = `${path} ${r.status}`;
    try {
      const j = (await r.json()) as { error?: string };
      if (j?.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return (await r.json()) as T;
}

export const api = {
  health: () => jfetch<{ ok: boolean; time: number }>('/api/health'),
  providers: () => jfetch<ProvidersInfo>('/api/providers'),
  setProviders: (body: {
    keys?: Partial<Record<CloudProvider, string | null>>;
    prefs?: Partial<ProviderPrefs>;
    refreshOllama?: boolean;
  }) =>
    jfetch<ProvidersInfo>('/api/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  test: (body: {
    tier?: 'council' | 'society' | 'chat';
    provider?: 'anthropic' | 'openai' | 'gemini' | 'hf' | 'ollama';
    prompt: string;
    system?: string;
    fresh?: boolean;
  }) =>
    jfetch<{
      provider: string;
      model: string;
      response: string;
      elapsedMs: number;
      cached: boolean;
    }>('/api/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  clearCache: () =>
    jfetch<{ cleared: number }>('/api/cache', { method: 'DELETE' }),
  startRun: (body: {
    scenario: string;
    societyParams?: Partial<SocietyParams>;
    providerPrefs?: Partial<ProviderPrefs>;
    subset?: number;
    societySize?: number;
    fresh?: boolean;
    canon?: string;
    legalJurisdiction?: LegalJurisdiction;
    justifyAll?: boolean;
  }) =>
    jfetch<{ runId: string; status: Run['status'] }>('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  getRun: (id: string) => jfetch<Run>(`/api/run/${encodeURIComponent(id)}`),
  getAgent: (runId: string, agentId: string) =>
    jfetch<CouncilAgentResult>(
      `/api/run/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}`,
    ),
  justifyAgent: (
    runId: string,
    agentId: string,
    body: { fresh?: boolean; legalJurisdiction?: LegalJurisdiction } = {},
  ) =>
    jfetch<JustificationResponse>(
      `/api/run/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}/justify`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  getJustification: async (runId: string, agentId: string) => {
    const r = await fetch(
      `/api/run/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}/justify`,
    );
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return (await r.json()) as JustificationResponse;
  },
  listJustifications: (runId: string) =>
    jfetch<{ items: JustificationResponse[] }>(
      `/api/run/${encodeURIComponent(runId)}/justifications`,
    ),
  justifyGroup: (
    runId: string,
    profession: string,
    body: { fresh?: boolean; legalJurisdiction?: LegalJurisdiction } = {},
  ) =>
    jfetch<GroupJustificationResponse>(
      `/api/run/${encodeURIComponent(runId)}/group/${encodeURIComponent(profession)}/justify`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  getGroupJustification: async (runId: string, profession: string) => {
    const r = await fetch(
      `/api/run/${encodeURIComponent(runId)}/group/${encodeURIComponent(profession)}/justify`,
    );
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return (await r.json()) as GroupJustificationResponse;
  },
  startJustifyAll: (
    runId: string,
    body: { fresh?: boolean; legalJurisdiction?: LegalJurisdiction } = {},
  ) =>
    jfetch<{ runId: string; total: number; status: 'started' | 'already-running' }>(
      `/api/run/${encodeURIComponent(runId)}/justify-all`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  getJustifyAllStatus: (runId: string) =>
    jfetch<{ runId: string; total: number; running: boolean }>(
      `/api/run/${encodeURIComponent(runId)}/justify-all`,
    ),
  getCanon: () => jfetch<{ works: CanonWork[] }>('/api/canon'),
  replaceCanon: (works: CanonWork[]) =>
    jfetch<{ count: number; works: CanonWork[] }>('/api/canon', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ works }),
    }),
  importCanon: (body: { format: 'json' | 'bib'; text: string; mode?: 'replace' | 'append' }) =>
    jfetch<{ imported: number; count: number; works: CanonWork[] }>('/api/canon/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  // ─── WMTR ──────────────────────────────────────────────────────────────
  runWmtr: (body: {
    scenario: string;
    overrides?: Partial<WmtrSingleParams>;
    intervention?: Intervention;
  }) =>
    jfetch<RunWmtr & { evidence: string }>('/api/wmtr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  intervene: (
    runId: string,
    body: {
      intervention: Intervention;
      recouncil?: boolean;
      subset?: number;
      societySize?: number;
      fresh?: boolean;
    },
  ) =>
    jfetch<{ runId: string | null; status?: Run['status']; wmtr?: RunWmtr; wmtrConfig?: unknown }>(
      `/api/run/${encodeURIComponent(runId)}/intervene`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
};

export type StreamEvent =
  | { type: 'status'; status: Run['status'] }
  | { type: 'round_start'; round: 1 | 2 | 3; total: number }
  | { type: 'agent_done'; round: 1 | 2 | 3; agentId: string; done: number; total: number }
  | { type: 'round_done'; round: 1 | 2 | 3; total: number; elapsedMs: number }
  | { type: 'society_start'; total: number }
  | { type: 'society_progress'; done: number; total: number }
  | { type: 'society_done'; total: number; elapsedMs: number }
  | { type: 'society_error'; agentId: string; message: string }
  | { type: 'justify_start'; total: number }
  | {
      type: 'justify_progress';
      agentId: string;
      done: number;
      total: number;
      cached: boolean;
    }
  | { type: 'justify_done'; total: number; elapsedMs: number; errors: number }
  | { type: 'error'; message: string; agentId?: string; round?: 1 | 2 | 3 }
  | { type: 'done'; runId: string; summary: RunSummary };

export function streamRun(runId: string, onEvent: (e: StreamEvent) => void): EventSource {
  const es = new EventSource(`/api/run/${encodeURIComponent(runId)}/stream`);
  es.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data) as StreamEvent;
      onEvent(e);
      if (e.type === 'done' || e.type === 'error') es.close();
    } catch {
      // ignore parse failures
    }
  };
  es.onerror = () => {
    // browser will retry; let consumer decide whether to close
  };
  return es;
}

export type JustifyAllStreamEvent =
  | { type: 'justify_start'; total: number }
  | {
      type: 'justify_progress';
      agentId: string;
      done: number;
      total: number;
      cached: boolean;
    }
  | { type: 'justify_done'; total: number; elapsedMs: number; errors: number }
  | { type: 'error'; message: string };

export function streamJustifyAll(
  runId: string,
  onEvent: (e: JustifyAllStreamEvent) => void,
): EventSource {
  const es = new EventSource(`/api/run/${encodeURIComponent(runId)}/justify-all/stream`);
  es.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data) as JustifyAllStreamEvent;
      onEvent(e);
      if (e.type === 'justify_done' || e.type === 'error') es.close();
    } catch {
      /* ignore */
    }
  };
  return es;
}

export type ChatEvent =
  | { type: 'chunk'; text: string }
  | { type: 'done'; provider: string; model: string }
  | { type: 'error'; message: string };

export interface StreamChatHandle {
  abort(): void;
  done: Promise<void>;
}

export function streamChat(
  body: {
    runId: string;
    message: string;
    history?: { role: 'user' | 'assistant'; content: string }[];
    fresh?: boolean;
  },
  onEvent: (e: ChatEvent) => void,
): StreamChatHandle {
  const ctrl = new AbortController();
  const done = (async () => {
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) {
        onEvent({ type: 'error', message: `chat ${r.status}` });
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buf += dec.decode(value, { stream: true });
        let i = buf.indexOf('\n\n');
        while (i !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of frame.split('\n')) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const payload = t.slice(5).trim();
            if (!payload) continue;
            try {
              onEvent(JSON.parse(payload) as ChatEvent);
            } catch {
              // skip malformed
            }
          }
          i = buf.indexOf('\n\n');
        }
      }
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') {
        onEvent({ type: 'error', message: e instanceof Error ? e.message : 'chat failed' });
      }
    }
  })();
  return { abort: () => ctrl.abort(), done };
}

export async function syncKeysToServer(): Promise<ProvidersInfo> {
  const keys = loadKeys();
  return api.setProviders({ keys });
}
