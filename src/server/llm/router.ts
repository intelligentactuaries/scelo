import type { ProviderPrefs, ProvidersInfo, Tier } from '../../shared/types';
import { cacheKey, readCache, writeCache, clearCache } from './cache';
import { callOllama, callOllamaStream, listOllamaModels, pickOllamaModel } from './ollama';
import { callClaude } from './claude';
import { callOpenAI } from './openai';
import { callGemini } from './gemini';
import { callHF } from './hf';

export type Role = 'system' | 'user' | 'assistant';
export interface Message {
  role: Role;
  content: string;
}

export type CloudProvider = 'anthropic' | 'openai' | 'gemini' | 'hf';
export type Provider = CloudProvider | 'ollama';

export interface ProviderCall {
  apiKey?: string;
  model: string;
  messages: Message[];
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
  hf: 'meta-llama/Llama-3.1-8B-Instruct',
  ollama: 'qwen2.5:7b-instruct-q4_K_M',
};

const DEFAULT_PREFS: ProviderPrefs = {
  councilProvider: 'auto',
  societyProvider: 'auto',
  chatProvider: 'auto',
  models: {},
};

class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly cap: number) {}
  async acquire(): Promise<void> {
    if (this.active >= this.cap) {
      await new Promise<void>((res) => this.waiting.push(res));
    }
    this.active++;
  }
  release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) next();
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export interface RouteOpts {
  fresh?: boolean;
  temperature?: number;
  maxTokens?: number;
  provider?: Provider;
  /** Caller cancellation (merged with the per-request timeout). */
  signal?: AbortSignal;
  /** Per-request timeout in ms; defaults to DEFAULT_LLM_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Extra value folded into the cache key.
   *
   * The cache is keyed on the exact prompt, which is right for the council
   * and society tiers — the same question deserves the same answer, and a
   * re-run should not re-burn minutes of GPU. It is WRONG for a Monte Carlo
   * microsimulation, where every run is meant to be an independent draw:
   * identical prompts made each re-run replay the previous run's answers
   * instantly, freezing the output table. Passing the run's seed here makes
   * a new draw miss the cache while a pinned seed hits it exactly, which is
   * what reproducibility actually requires.
   *
   * Opt-in, so callers that want plain prompt-level caching are unaffected.
   */
  cacheSalt?: string | number;
}

// A single stalled LLM request must never hang the whole run. Non-streaming
// calls (council + society) previously had no timeout at all, so one wedged
// Ollama request left the society's Promise.all pending forever and the run
// stuck in `running`. Every non-streaming request now gets a bounded timeout
// that aborts the underlying fetch; on timeout the caller's try/catch treats it
// as an error result and the run completes. Override via SWARM_LLM_TIMEOUT_MS.
const DEFAULT_LLM_TIMEOUT_MS = Number(process.env.SWARM_LLM_TIMEOUT_MS) || 180_000;

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`llm request timed out after ${ms}ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

class LLMRouter {
  private keys: Partial<Record<CloudProvider, string>> = {};
  private prefs: ProviderPrefs = { ...DEFAULT_PREFS };
  private ollamaAvailable: string[] = [];
  private ollamaSelected: string | null = null;
  private cloudSem = new Semaphore(8);
  private ollamaSem = new Semaphore(32);

  async init(): Promise<void> {
    await this.refreshOllama();
  }

  async refreshOllama(): Promise<void> {
    this.ollamaAvailable = await listOllamaModels();
    const overridden = this.prefs.models?.ollama;
    this.ollamaSelected =
      overridden && this.ollamaAvailable.includes(overridden)
        ? overridden
        : pickOllamaModel(this.ollamaAvailable);
  }

  setKey(provider: CloudProvider, key: string | null | undefined): void {
    if (!key) delete this.keys[provider];
    else this.keys[provider] = key;
  }

  setKeys(keys: Partial<Record<CloudProvider, string | null>>): void {
    for (const [p, k] of Object.entries(keys)) this.setKey(p as CloudProvider, k);
  }

  setPrefs(prefs: Partial<ProviderPrefs>): void {
    this.prefs = {
      ...this.prefs,
      ...prefs,
      models: { ...this.prefs.models, ...(prefs.models ?? {}) },
    };
    // refresh in case ollama model override changed
    this.refreshOllama();
  }

  info(): ProvidersInfo {
    return {
      configured: {
        anthropic: !!this.keys.anthropic,
        openai: !!this.keys.openai,
        gemini: !!this.keys.gemini,
        hf: !!this.keys.hf,
      },
      ollamaModels: this.ollamaAvailable,
      ollamaSelected: this.ollamaSelected,
      prefs: this.prefs,
    };
  }

  modelFor(provider: Provider): string {
    if (provider === 'ollama') return this.ollamaSelected ?? DEFAULT_MODELS.ollama;
    return this.prefs.models?.[provider] ?? DEFAULT_MODELS[provider];
  }

  private firstCloud(): CloudProvider | null {
    const order: CloudProvider[] = ['anthropic', 'openai', 'gemini', 'hf'];
    return order.find((p) => this.keys[p]) ?? null;
  }

  selectProvider(tier: Tier): Provider | null {
    const pref =
      tier === 'council'
        ? this.prefs.councilProvider
        : tier === 'society'
          ? this.prefs.societyProvider
          : this.prefs.chatProvider;
    if (pref !== 'auto') {
      if (pref === 'ollama') return this.ollamaSelected ? 'ollama' : null;
      return this.keys[pref] ? pref : null;
    }
    // Local-first (Scelo default): under 'auto', prefer a loaded local Ollama
    // model for every tier — council, chat, and society — falling back to the
    // first cloud provider that has a key. Keeps runs local, free, and private
    // whenever a local model is present; picking an explicit provider above
    // still forces cloud. (Previously council/chat preferred cloud, which routed
    // to a stray/misconfigured cloud key even with a local model loaded.)
    return this.ollamaSelected ? 'ollama' : this.firstCloud();
  }

  async route(messages: Message[], tier: Tier, opts: RouteOpts = {}): Promise<string> {
    const { text } = await this.routeWithMeta(messages, tier, opts);
    return text;
  }

  async routeWithMeta(
    messages: Message[],
    tier: Tier,
    opts: RouteOpts = {},
  ): Promise<{ text: string; provider: Provider; model: string; cached: boolean }> {
    const provider = opts.provider ?? this.selectProvider(tier);
    if (!provider) {
      throw new Error(
        'no provider available — add a cloud key or install an ollama instruction model',
      );
    }
    const model = this.modelFor(provider);
    const key = cacheKey({
      provider,
      model,
      messages,
      opts: { t: opts.temperature, mt: opts.maxTokens, salt: opts.cacheSalt },
    });
    if (!opts.fresh) {
      const cached = readCache(key);
      if (cached !== null) return { text: cached, provider, model, cached: true };
    }
    const call: ProviderCall = {
      apiKey: provider === 'ollama' ? undefined : this.keys[provider as CloudProvider],
      model,
      messages,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    };
    const sem = provider === 'ollama' ? this.ollamaSem : this.cloudSem;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    const result = await sem.run(() => {
      // Start the timeout AFTER acquiring the semaphore so queue time doesn't
      // count against it. The AbortController cancels the underlying fetch
      // (Ollama honours c.signal); withTimeout also rejects so a provider that
      // ignores the signal still can't hang the run.
      const ac = new AbortController();
      const signal = opts.signal ? AbortSignal.any([opts.signal, ac.signal]) : ac.signal;
      return withTimeout(dispatch(provider, { ...call, signal }), timeoutMs, () => ac.abort());
    });
    writeCache(key, provider, model, result);
    return { text: result, provider, model, cached: false };
  }

  clearCache(): number {
    return clearCache();
  }

  async *routeStream(
    messages: Message[],
    tier: Tier,
    opts: RouteOpts = {},
  ): AsyncGenerator<string, { provider: Provider; model: string; cached: boolean; full: string }> {
    const provider = opts.provider ?? this.selectProvider(tier);
    if (!provider) {
      throw new Error(
        'no provider available — add a cloud key or install an ollama instruction model',
      );
    }
    const model = this.modelFor(provider);
    const key = cacheKey({
      provider,
      model,
      messages,
      opts: { t: opts.temperature, mt: opts.maxTokens, stream: true, salt: opts.cacheSalt },
    });
    if (!opts.fresh) {
      const cached = readCache(key);
      if (cached !== null) {
        yield cached;
        return { provider, model, cached: true, full: cached };
      }
    }
    const call: ProviderCall = {
      apiKey: provider === 'ollama' ? undefined : this.keys[provider as CloudProvider],
      model,
      messages,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    };
    const sem = provider === 'ollama' ? this.ollamaSem : this.cloudSem;
    let acc = '';
    await sem.acquire();
    try {
      if (provider === 'ollama') {
        for await (const piece of callOllamaStream(call)) {
          acc += piece;
          yield piece;
        }
      } else {
        // cloud providers don't stream in v1 — single chunk emission
        const full = await dispatch(provider, call);
        acc = full;
        yield acc;
      }
    } finally {
      sem.release();
    }
    writeCache(key, provider, model, acc);
    return { provider, model, cached: false, full: acc };
  }
}

function dispatch(provider: Provider, c: ProviderCall): Promise<string> {
  switch (provider) {
    case 'ollama':
      return callOllama(c);
    case 'anthropic':
      return callClaude(c);
    case 'openai':
      return callOpenAI(c);
    case 'gemini':
      return callGemini(c);
    case 'hf':
      return callHF(c);
  }
}

export const router = new LLMRouter();
