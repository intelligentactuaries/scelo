// Shared "draft" persistence for in-flight typing surfaces (AI panel
// input, Source Control commit message, Chat input, Search query +
// replacement). Same contract everywhere : the value persists to
// localStorage on every change so navigating away never costs a
// draft, and is cleared only by an explicit user action (send, save,
// or the "Reset all drafts" palette command).
//
// Keys are namespaced with `IA_DRAFT_PREFIX` so resetAll() can wipe
// every IDE draft in one pass without touching unrelated localStorage.

import { useCallback, useEffect, useState } from "react";

export const IA_DRAFT_PREFIX = "ia.draft.";

function readDraft(key: string): string {
  if (typeof localStorage === "undefined") return "";
  try {
    return localStorage.getItem(IA_DRAFT_PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (value === "") localStorage.removeItem(IA_DRAFT_PREFIX + key);
    else localStorage.setItem(IA_DRAFT_PREFIX + key, value);
  } catch {
    // QuotaExceededError on private-mode browsers : best-effort,
    // typing surfaces still work, they just lose their backup.
  }
}

type DraftSetter = (next: string | ((prev: string) => string)) => void;

/** Drop-in replacement for `useState<string>` that persists the value
 *  under `IA_DRAFT_PREFIX + key`. Hydrates on mount, clears the
 *  storage entry when the value goes empty (so abandoned drafts
 *  don't clutter localStorage forever). Setter accepts both the
 *  literal-string and functional-updater forms so it's a true
 *  drop-in for `useState`.
 *
 *  Caller is responsible for clearing the draft when "send" /
 *  "save" succeeds — either by calling the returned setter with ""
 *  or by calling clearDraft(key) directly. */
export function useDraft(key: string): [string, DraftSetter] {
  const [value, setValueState] = useState<string>(() => readDraft(key));

  // Re-hydrate when the key changes (eg switching conversations).
  useEffect(() => {
    setValueState(readDraft(key));
  }, [key]);

  const setValue = useCallback<DraftSetter>(
    (next) => {
      setValueState((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        writeDraft(key, resolved);
        return resolved;
      });
    },
    [key],
  );

  return [value, setValue];
}

export function clearDraft(key: string): void {
  writeDraft(key, "");
}

/** Wipe every IDE draft. Called by the "Reset: All IDE Drafts"
 *  palette command. Doesn't touch persisted workspace / chat
 *  history — only the ephemeral in-flight typing buffers. */
export function clearAllDrafts(): number {
  if (typeof localStorage === "undefined") return 0;
  const toDrop: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(IA_DRAFT_PREFIX)) toDrop.push(k);
    }
    for (const k of toDrop) localStorage.removeItem(k);
  } catch {
    // ignore
  }
  return toDrop.length;
}
