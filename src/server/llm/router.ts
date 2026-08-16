import type { ProviderPrefs, ProvidersInfo, Tier } from '../../shared/types';
import { cacheKey, readCache, writeCache, clearCache } from './cache';
import { callOllama, callOllamaStream, listOllamaModels, pickOllamaModel } from './ollama';
import { callClaude } from './claude';
import { callOpenAI } from './openai';
import { callGemini } from './gemini';
import { callHF } from './hf';
import {
  CLAUDE_CODE_DEFAULT_MODEL,
  UNAVAILABLE as CLAUDE_CODE_UNAVAILABLE,
  callClaudeCode,
  detectClaudeCode,
  type ClaudeCodeStatus,
} from './claudeCode';

export type Role = 'system' | 'user' | 'assistant';
export interface Message {
  role: Role;
  content: string;
}

/** The providers that take an API key. */
export type CloudProvider = 'anthropic' | 'openai' | 'gemini' | 'hf';
/** Everything the router can dispatch to. `claude_code` is keyless like
 *  ollama but metered like the cloud — it spends the user's Claude plan. */
export type Provider = CloudProvider | 'ollama' | 'claude_code';

const CLOUD_ORDER: CloudProvider[] = ['anthropic', 'openai', 'gemini', 'hf'];
function isCloud(p: Provider): p is CloudProvider {
  return (CLOUD_ORDER as string[]).includes(p);
}

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
  // Not a model id: "inherit whatever the CLI is set to". A user's own
  // /model choice is the right default for their own subscription.
  claude_code: CLAUDE_CODE_DEFAULT_MODEL,
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

const NO_PROVIDER =
  'no provider available — add a cloud key, sign in to Claude Code, or install an ollama instruction model';

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

// Every Claude Code call is a fresh CLI process — measured at ~350 MB peak
// RSS and ~2.4 s for a trivial prompt — so its concurrency is its own knob,
// separate from the cloud pool: 4 in flight is ~1.4 GB, which a laptop
// running ollama beside the swarm can absorb. Raise it on a bigger box.
const CLAUDE_CODE_CONCURRENCY = Number(process.env.SWARM_CLAUDE_CODE_CONCURRENCY) || 4;

class LLMRouter {
  private keys: Partial<Record<CloudProvider, string>> = {};
  private prefs: ProviderPrefs = { ...DEFAULT_PREFS };
  private ollamaAvailable: string[] = [];
  private ollamaSelected: string | null = null;
  private claudeCode: ClaudeCodeStatus = CLAUDE_CODE_UNAVAILABLE;
  private cloudSem = new Semaphore(8);
  private ollamaSem = new Semaphore(32);
  private claudeCodeSem = new Semaphore(CLAUDE_CODE_CONCURRENCY);

  async init(): Promise<void> {
    await Promise.all([this.refreshOllama(), this.refreshClaudeCode()]);
  }

  async refreshOllama(): Promise<void> {
    this.ollamaAvailable = await listOllamaModels();
    const overridden = this.prefs.models?.ollama;
    this.ollamaSelected =
      overridden && this.ollamaAvailable.includes(overridden)
        ? overridden
        : pickOllamaModel(this.ollamaAvailable);
  }

  async refreshClaudeCode(): Promise<void> {
    this.claudeCode = await detectClaudeCode();
  }

  setKey(provider: CloudProvider, key: string | null | undefined): void {
    if (!key) delete this.keys[provider];
    else this.keys[provider] = key;
  }

  setKeys(keys: Partial<Record<CloudProvider, string | null>>): void {
    for (const [p, k] of Object.entries(keys)) this.setKey(p as CloudProvider, k);
  }

  setPrefs(prefs: Partial<ProviderPrefs>): void {
    // `models` is replaced, not merged. The vault sends the whole map on
    // every save and clears an override by leaving its key out (JSON drops
    // an `undefined` field), so a merge here made overrides un-clearable:
    // the field emptied in the form, then re-filled from the server's echo,
    // and only a server restart forgot the model.
    this.prefs = {
      ...this.prefs,
      ...prefs,
      models: prefs.models ?? this.prefs.models,
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
        claude_code: this.claudeCode.available,
      },
      ollamaModels: this.ollamaAvailable,
      ollamaSelected: this.ollamaSelected,
      claudeCode: {
        available: this.claudeCode.available,
        version: this.claudeCode.version,
        bin: this.claudeCode.bin,
        reason: this.claudeCode.reason,
      },
      prefs: this.prefs,
      // What each tier will ACTUALLY use, resolved through the same
      // selectProvider the run takes. The header used to hardcode the ollama
      // model, so a run served by a cloud key still read "ollama: <model>"
      // and — worse — a session whose key the server had forgotten looked
      // identical to one that never had a key. One source of truth.
      effective: {
        council: this.effectiveFor('council'),
        society: this.effectiveFor('society'),
        chat: this.effectiveFor('chat'),
      },
    };
  }

  private effectiveFor(tier: Tier): { provider: Provider; model: string } | null {
    const provider = this.selectProvider(tier);
    return provider ? { provider, model: this.modelFor(provider) } : null;
  }

  modelFor(provider: Provider): string {
    if (provider === 'ollama') return this.ollamaSelected ?? DEFAULT_MODELS.ollama;
    return this.prefs.models?.[provider] ?? DEFAULT_MODELS[provider];
  }

  private firstCloud(): CloudProvider | null {
    return CLOUD_ORDER.find((p) => this.keys[p]) ?? null;
  }

  private claudeCodeIfAvailable(): 'claude_code' | null {
    return this.claudeCode.available ? 'claude_code' : null;
  }

  private ollamaIfLoaded(): 'ollama' | null {
    return this.ollamaSelected ? 'ollama' : null;
  }

  selectProvider(tier: Tier): Provider | null {
    const pref =
      tier === 'council'
        ? this.prefs.councilProvider
        : tier === 'society'
          ? this.prefs.societyProvider
          : this.prefs.chatProvider;
    if (pref !== 'auto') {
      if (pref === 'ollama') return this.ollamaIfLoaded();
      if (pref === 'claude_code') return this.claudeCodeIfAvailable();
      return this.keys[pref] ? pref : null;
    }
    // 'auto' routes by tier COST, because the tiers differ by ~50x in call
    // volume and a single policy can't serve both:
    //
    //   council (12–192 calls/run) and chat (1 call/message) → a configured
    //     cloud key when there is one, else a signed-in Claude Code, else
    //     ollama. Deliberating agents and chat are where answer quality is
    //     felt, and the volume is small enough to pay for. Claude Code sits
    //     between the two because it is metered like the cloud (it draws on
    //     the user's Claude plan) but was never an explicit act the way
    //     pasting a key is — merely having the CLI installed must not
    //     outrank a key someone deliberately connected.
    //
    //   society (1000 agents/run by default, one call each) → stays local
    //     whenever a model is loaded. Sending it to a metered API turns one
    //     ordinary run into ~1000 billed calls, which is not what anyone
    //     means by "auto". Claude Code is the last resort here for the same
    //     reason, and because each of those calls is a fresh CLI process.
    //
    // Either tier still falls back to whatever else exists, and an explicit
    // provider above overrides all of this. (History: 'auto' was once
    // cloud-first for every tier, which routed to a stray misconfigured key
    // even with a local model loaded; the fix made everything local-first,
    // which then made a deliberately connected cloud key look ignored. This
    // splits the difference along the axis that actually matters — spend.)
    if (tier === 'society') {
      return this.ollamaIfLoaded() ?? this.firstCloud() ?? this.claudeCodeIfAvailable();
    }
    return this.firstCloud() ?? this.claudeCodeIfAvailable() ?? this.ollamaIfLoaded();
  }

  private semFor(provider: Provider): Semaphore {
    if (provider === 'ollama') return this.ollamaSem;
    if (provider === 'claude_code') return this.claudeCodeSem;
    return this.cloudSem;
  }

  private callFor(provider: Provider, messages: Message[], opts: RouteOpts): ProviderCall {
    return {
      apiKey: isCloud(provider) ? this.keys[provider] : undefined,
      model: this.modelFor(provider),
      messages,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    };
  }

  private dispatch(provider: Provider, c: ProviderCall): Promise<string> {
    switch (provider) {
      case 'ollama':
        return callOllama(c);
      case 'claude_code':
        return callClaudeCode(c, this.claudeCode);
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
    if (!provider) throw new Error(NO_PROVIDER);
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
    const call = this.callFor(provider, messages, opts);
    const sem = this.semFor(provider);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    const result = await sem.run(() => {
      // Start the timeout AFTER acquiring the semaphore so queue time doesn't
      // count against it. The AbortController cancels the underlying fetch
      // (Ollama honours c.signal; Claude Code kills its CLI process);
      // withTimeout also rejects so a provider that ignores the signal still
      // can't hang the run.
      const ac = new AbortController();
      const signal = opts.signal ? AbortSignal.any([opts.signal, ac.signal]) : ac.signal;
      return withTimeout(this.dispatch(provider, { ...call, signal }), timeoutMs, () => ac.abort());
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
    if (!provider) throw new Error(NO_PROVIDER);
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
    const call = this.callFor(provider, messages, opts);
    const sem = this.semFor(provider);
    let acc = '';
    await sem.acquire();
    try {
      if (provider === 'ollama') {
        for await (const piece of callOllamaStream(call)) {
          acc += piece;
          yield piece;
        }
      } else {
        // cloud providers (and the Claude Code CLI) don't stream in v1 —
        // single chunk emission
        const full = await this.dispatch(provider, call);
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

export const router = new LLMRouter();
