// LSP health pings — a tiny pub/sub the LspClient writes to and the
// StatusBar subscribes to. Decouples the lifecycle (started, stopped,
// errored) from the consumer so the editor can render an indicator
// dot without poking at LspClient internals.
//
// Pattern mirrors `./toastBus.ts`: emit-side has no React deps, the
// receiver wires `useEffect(() => subscribe(...), [])`.

import type { LspLang } from "./sceloIDE";

export type LspStatus = "off" | "starting" | "live" | "error";

export interface LspStatusEvent {
  lang: LspLang;
  status: LspStatus;
}

type Listener = (e: LspStatusEvent) => void;

const listeners = new Set<Listener>();
const lastByLang = new Map<LspLang, LspStatus>();

export function emitLspStatus(lang: LspLang, status: LspStatus): void {
  if (lastByLang.get(lang) === status) return;
  lastByLang.set(lang, status);
  const e: LspStatusEvent = { lang, status };
  for (const fn of listeners) fn(e);
}

export function getLspStatus(lang: LspLang): LspStatus {
  return lastByLang.get(lang) ?? "off";
}

export function subscribeLspStatus(fn: Listener): () => void {
  listeners.add(fn);
  // Replay current snapshot so the subscriber doesn't have to wait for
  // the next state change to render its first row.
  for (const [lang, status] of lastByLang) fn({ lang, status });
  return () => {
    listeners.delete(fn);
  };
}
