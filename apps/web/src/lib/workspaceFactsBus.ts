// Workspace facts bus — the IDE-wide global workspace.
//
// A small, capacity-limited set of nameable, causally-validated facts currently
// "in play" across the pipeline: a validated workspace direction from Hard, a
// decision-relevant driver flagged in Soft, an ignited synthesis from the Swarm.
// Facts are broadcast here and surfaced in the persistent Workspace panel, the
// literal instantiation of "verbalizable representations form a global
// workspace" for the IDE itself. Same module-scope pub/sub shape as the other
// buses (aiPanelBus, toastBus, ...).

import type { WorkspaceFact } from "../components/Scelo/workspace/types";

export type { WorkspaceFact };

// Capacity limit: the global workspace is small on purpose (the GWT / paper
// ceiling of a handful to a couple dozen items). Oldest fall off first.
const CAPACITY = 24;

type Listener = (facts: WorkspaceFact[]) => void;
const listeners = new Set<Listener>();
let facts: WorkspaceFact[] = [];

function notify(): void {
  for (const fn of listeners) fn(facts);
}

/** Broadcast a fact into the global workspace. Idempotent on `id`: re-emitting
 *  the same id refreshes it and moves it to the front. */
export function emitWorkspaceFact(fact: WorkspaceFact): void {
  facts = [fact, ...facts.filter((f) => f.id !== fact.id)].slice(0, CAPACITY);
  notify();
}

/** Remove a fact by id (e.g. the user dismisses it). */
export function removeWorkspaceFact(id: string): void {
  const next = facts.filter((f) => f.id !== id);
  if (next.length === facts.length) return;
  facts = next;
  notify();
}

/** Replace the whole fact set (used to hydrate from persisted workspace state). */
export function setWorkspaceFacts(next: WorkspaceFact[]): void {
  facts = next.slice(0, CAPACITY);
  notify();
}

export function clearWorkspaceFacts(): void {
  if (facts.length === 0) return;
  facts = [];
  notify();
}

export function getWorkspaceFacts(): WorkspaceFact[] {
  return facts;
}

export function subscribeWorkspaceFacts(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
