// First-run AI provider onboarding gate.
//
// On every IDE launch we check three things:
//   1. Has the user been shown this prompt already?  (localStorage marker)
//   2. Has the user explicitly picked a provider?    (LS_ACTIVE key)
//   3. Is Ollama running locally?                    (HTTP probe)
//
// The modal only shows when ALL three say "no" — so users with Ollama
// already running, or who've picked a provider, never see it.

const SHOWN_KEY = "ia.firstRun.aiPrompt.shown.v1";
const ACTIVE_KEY = "ia.aiProvider.active";
const OLLAMA_PROBE_URL = "http://localhost:11434/api/tags";
const OLLAMA_PROBE_TIMEOUT_MS = 800;

export function hasShownFirstRunPrompt(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(SHOWN_KEY) === "1";
}

export function markFirstRunPromptShown(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SHOWN_KEY, "1");
  } catch {
    // Quota / private mode : the worst case is the prompt re-fires next
    // launch, which is mildly annoying but not broken.
  }
}

export function hasPickedProvider(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(ACTIVE_KEY) !== null;
}

/** Short-timeout fetch — Ollama responds in <50 ms when running, and
 *  we don't want to delay the IDE boot for users who don't have it. */
export async function probeOllamaRunning(): Promise<boolean> {
  if (typeof fetch === "undefined") return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), OLLAMA_PROBE_TIMEOUT_MS);
    const r = await fetch(OLLAMA_PROBE_URL, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

export async function shouldShowFirstRunPrompt(): Promise<boolean> {
  if (hasShownFirstRunPrompt()) return false;
  if (hasPickedProvider()) {
    // User has explicitly chosen — record so we don't re-probe next time.
    markFirstRunPromptShown();
    return false;
  }
  const ollamaUp = await probeOllamaRunning();
  if (ollamaUp) {
    // Ollama is already running locally; the default works for them.
    markFirstRunPromptShown();
    return false;
  }
  return true;
}
