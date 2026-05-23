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
    if (tier === 'society') {
      return this.ollamaSelected ? 'ollama' : this.firstCloud();
    }
    // council + chat default to cloud, fall back to ollama
    return this.firstCloud() ?? (this.ollamaSelected ? 'ollama' : null);
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
      opts: { t: opts.temperature, mt: opts.maxTokens },
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
    const result = await sem.run(() => dispatch(provider, call));
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
      opts: { t: opts.temperature, mt: opts.maxTokens, stream: true },
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
