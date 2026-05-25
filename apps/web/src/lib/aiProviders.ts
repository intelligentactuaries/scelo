// AI providers — client-side config for which LLM Scelo's chat & agents
// should talk to. Default is Ollama (local, no key). Users can opt into
// Anthropic / OpenAI / Gemini / any OpenAI-compatible endpoint.
//
// Storage strategy:
//   * Inside Scelo IDE (window.scelo)  → Electron safeStorage IPC, which
//     delegates to the OS keychain (Keychain on macOS, DPAPI on Windows,
//     libsecret on Linux). The renderer never sees the encrypted blob.
//   * Outside the IDE (regular browser) → localStorage. Less secure (the
//     key sits in the browser's storage), but the user opted in by
//     choosing a hosted provider in a browser tab. UI surfaces the
//     warning via `isSecureStore()`.
//
// The active provider id + selection metadata are kept in localStorage
// regardless — only the *secret* lives in the keychain when available.
// That way the renderer can read "which provider is selected" without
// an IPC round-trip on every chat call.

import { isDesktopIDE } from "./sceloIDE";

export type ProviderId =
  | "ollama"
  | "openrouter"
  | "anthropic"
  | "openai"
  | "gemini"
  | "openai_compat";

export interface ProviderConfig {
  id: ProviderId;
  apiKey: string;       // empty for Ollama / not-yet-configured
  model?: string;
  baseUrl?: string;
}

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  blurb: string;
  needsKey: boolean;
  defaultModel: string;
  modelHint: string;
  needsBaseUrl: boolean;
  baseUrlPlaceholder?: string;
  keyHelpUrl: string;
}

export const PROVIDER_CATALOG: ProviderDescriptor[] = [
  {
    id: "ollama",
    label: "Ollama (local · default)",
    blurb:
      "Runs the LLM on this machine via Ollama. No API key, no spend, no network. The default.",
    needsKey: false,
    defaultModel: "qwen2.5:7b-instruct-q4_K_M",
    modelHint: "Set via the orchestrator env; the model must be pulled via `ollama pull`.",
    needsBaseUrl: false,
    keyHelpUrl: "https://ollama.com/download",
  },
  {
    id: "openrouter",
    label: "OpenRouter (Claude · GPT · Gemini · Llama · DeepSeek · …)",
    blurb:
      "One key, dozens of models. Unified API for Anthropic Claude, OpenAI GPT, Google Gemini, Meta Llama, DeepSeek, Mistral, Qwen, and the free-tier open-source set. Pick the model per request; pricing surfaces on openrouter.ai.",
    needsKey: true,
    defaultModel: "anthropic/claude-3.5-sonnet",
    modelHint:
      "Provider/model slug, eg anthropic/claude-3.5-sonnet, openai/gpt-4o, google/gemini-pro-1.5, meta-llama/llama-3.1-405b-instruct.",
    needsBaseUrl: false,
    keyHelpUrl: "https://openrouter.ai/keys",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    blurb: "Hosted Claude models — strongest reasoning, slower than OpenAI on equivalent tiers.",
    needsKey: true,
    defaultModel: "claude-sonnet-4-6",
    modelHint: "e.g. claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5",
    needsBaseUrl: false,
    keyHelpUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openai",
    label: "OpenAI (GPT / Codex)",
    blurb: "Hosted OpenAI models — broad capability range, the canonical Chat-Completions API.",
    needsKey: true,
    defaultModel: "gpt-4o-mini",
    modelHint: "e.g. gpt-4o, gpt-4o-mini, o1, gpt-5, codex-…",
    needsBaseUrl: false,
    keyHelpUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    blurb: "Hosted Google Gemini models — best price/perf on the experimental flash tier.",
    needsKey: true,
    defaultModel: "gemini-2.0-flash-exp",
    modelHint: "e.g. gemini-2.0-flash-exp, gemini-1.5-pro, gemini-1.5-flash",
    needsBaseUrl: false,
    keyHelpUrl: "https://aistudio.google.com/app/apikey",
  },
  {
    id: "openai_compat",
    label: "OpenAI-compatible (Together · Groq · LM Studio · vLLM · llama.cpp)",
    blurb:
      "Any inference server that implements /v1/chat/completions. Covers Together AI, Groq, Fireworks, Perplexity, LM Studio, vLLM, llama.cpp server, ollama's OpenAI shim, and more.",
    needsKey: true,
    defaultModel: "local-model",
    modelHint: "Model name as the upstream server reports it.",
    needsBaseUrl: true,
    baseUrlPlaceholder: "http://localhost:1234/v1",
    keyHelpUrl: "https://platform.openai.com/docs/api-reference/chat",
  },
];

const LS_ACTIVE = "ia.aiProvider.active";
const LS_BROWSER_KEY_PREFIX = "ia.aiProvider.browser.";

export function getActiveProviderId(): ProviderId {
  const v = (typeof localStorage !== "undefined" && localStorage.getItem(LS_ACTIVE)) || "ollama";
  if (PROVIDER_CATALOG.some((p) => p.id === v)) return v as ProviderId;
  return "ollama";
}

export function setActiveProviderId(id: ProviderId): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(LS_ACTIVE, id);
}

/** True when secrets live in the OS keychain (Scelo IDE + safeStorage available). */
export async function isSecureStore(): Promise<boolean> {
  if (!isDesktopIDE()) return false;
  try {
    const s = await window.scelo!.secrets.status();
    return s.available;
  } catch {
    return false;
  }
}

export async function getProviderConfig(
  id: ProviderId,
): Promise<ProviderConfig | null> {
  if (id === "ollama") {
    return { id: "ollama", apiKey: "" };
  }
  if (isDesktopIDE()) {
    const rec = await window.scelo!.secrets.get(id);
    if (!rec) return null;
    return {
      id,
      apiKey: rec.apiKey,
      model: rec.model ?? undefined,
      baseUrl: rec.baseUrl ?? undefined,
    };
  }
  // Browser fallback — localStorage.
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(LS_BROWSER_KEY_PREFIX + id);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ProviderConfig;
  } catch {
    return null;
  }
}

export async function setProviderConfig(cfg: ProviderConfig): Promise<void> {
  if (cfg.id === "ollama") return; // nothing to store
  if (isDesktopIDE()) {
    await window.scelo!.secrets.set(cfg.id, {
      apiKey: cfg.apiKey,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
    });
    return;
  }
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(LS_BROWSER_KEY_PREFIX + cfg.id, JSON.stringify(cfg));
}

export async function clearProviderConfig(id: ProviderId): Promise<void> {
  if (id === "ollama") return;
  if (isDesktopIDE()) {
    await window.scelo!.secrets.clear(id);
    return;
  }
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(LS_BROWSER_KEY_PREFIX + id);
}

/** Headers to attach to /api/agents/orchestrator/{stream,test} so the
 *  backend uses the active provider instead of its startup default. */
export async function activeProviderHeaders(): Promise<Record<string, string>> {
  const id = getActiveProviderId();
  if (id === "ollama") return {}; // backend default
  const cfg = await getProviderConfig(id);
  if (!cfg || !cfg.apiKey) return {}; // not configured → backend default
  const headers: Record<string, string> = {
    "X-IA-Provider": id,
    "X-IA-API-Key": cfg.apiKey,
  };
  if (cfg.model) headers["X-IA-Provider-Model"] = cfg.model;
  if (cfg.baseUrl) headers["X-IA-Base-URL"] = cfg.baseUrl;
  return headers;
}
