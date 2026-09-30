// Chat-driven model-stack mutations. The Tools chats can propose adding /
// removing / toggling models — this module is what makes those proposals
// REAL instead of conversational theatre: the assistant appends a fenced
// machine-readable directive to its reply, the chat surface parses it,
// validates every id against the fixed catalog, applies the change through
// the same setter the drag-and-drop UI uses, and replaces the fence with a
// human confirmation of what actually happened (including ids it refused).
//
// The protocol is deliberately assistant-emitted rather than user-parsed:
// "yes please" after a proposal only makes sense with the conversation in
// view, and the assistant is the one holding it.

import { MODEL_BY_ID, MODEL_CATALOG } from "./modelCatalog";
import { connectWire, createsCycle, disconnectWire, resolveWire, wireInto } from "./modelPorts";
import type { ModelWire } from "./pipeline";
import type { SelectedModel } from "./sceloContext";

export type WireOp = { from: string; to: string };

export type ModelDirective = {
  add: Array<{ id: string; rationale?: string }>;
  remove: string[];
  enable: string[];
  disable: string[];
  /** Plug `from`'s output into `to`'s input (Tools canvas wiring). */
  wire?: WireOp[];
  /** Pull that wire out. */
  unwire?: WireOp[];
};

export type DirectiveReport = {
  added: string[];
  removed: string[];
  enabled: string[];
  disabled: string[];
  /** Ids not in the catalog — refused, and said so. */
  unknown: string[];
  /** Valid ids that were no-ops (already attached / not attached). */
  skipped: string[];
};

const FENCE_RE = /```scelo-models\s*([\s\S]*?)```/;

/** Every model → model wire the typed pins allow, as "source → target". */
function wireableFlows(): string[] {
  const out: string[] = [];
  for (const s of MODEL_CATALOG) {
    for (const t of MODEL_CATALOG) if (resolveWire(s.id, t.id)) out.push(`${s.id} → ${t.id}`);
  }
  return out;
}

/** System-prompt addendum teaching the protocol. Appended to every Tools
 *  chat context so hub, per-model, and stage chats can all mutate the stack. */
export function modelDirectiveProtocol(): string {
  const catalog = MODEL_CATALOG.map((m) => `${m.id} (${m.family})`).join(", ");
  return [
    "",
    "STACK DIRECTIVES — you can modify the attached model stack yourself.",
    "When the user asks you to add / remove / enable / disable models (or",
    "confirms a mix you proposed), end your reply with EXACTLY one fenced",
    "block in this form:",
    "```scelo-models",
    '{"add":[{"id":"<catalog id>","rationale":"<≤14 words>"}],"remove":["<catalog id>"],"enable":[],"disable":[]}',
    "```",
    `Ids MUST come from this fixed catalog (anything else is refused): ${catalog}.`,
    'Wiring: to plug one model\'s output into another\'s input, add "wire":[{"from":"<id>","to":"<id>"}] (or "unwire" to pull one out) to the same block. Only these wires exist:',
    `${wireableFlows().join(", ")}. An input takes one wire: wiring cbd into lifecontingencies unplugs lee-carter. Both models must be attached (add them in the same block).`,
    "There is NO other way to change the stack from chat — never claim a",
    "model was added or locked in without emitting the block. Without a",
    "block, the stack is unchanged. Do not emit a block unless the user",
    "asked for a change or accepted your proposal. Keep the prose summary;",
    "the block is applied automatically and replaced by a confirmation.",
  ].join("\n");
}

/** Extract and validate a directive from an assistant reply. Returns null
 *  when no fenced block is present. Unknown ids are KEPT (in their lists)
 *  so the applier can report them — validation happens there. */
export function parseModelDirective(text: string): ModelDirective | null {
  const m = FENCE_RE.exec(text);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[1].trim());
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const addList = (v: unknown): Array<{ id: string; rationale?: string }> => {
    if (!Array.isArray(v)) return [];
    const out: Array<{ id: string; rationale?: string }> = [];
    for (const item of v) {
      if (typeof item === "string") out.push({ id: item });
      else if (
        item &&
        typeof item === "object" &&
        typeof (item as { id?: unknown }).id === "string"
      ) {
        const it = item as { id: string; rationale?: unknown };
        out.push({
          id: it.id,
          rationale: typeof it.rationale === "string" ? it.rationale : undefined,
        });
      }
    }
    return out;
  };
  // Wires: {"from","to"} objects, or "a -> b" / "a → b" strings.
  const wireList = (v: unknown): WireOp[] => {
    if (!Array.isArray(v)) return [];
    const out: WireOp[] = [];
    for (const item of v) {
      if (typeof item === "string") {
        const m = /^\s*([\w-]+)\s*(?:->|→|=>)\s*([\w-]+)\s*$/.exec(item);
        if (m) out.push({ from: m[1], to: m[2] });
      } else if (item && typeof item === "object") {
        const it = item as { from?: unknown; to?: unknown };
        if (typeof it.from === "string" && typeof it.to === "string") {
          out.push({ from: it.from, to: it.to });
        }
      }
    }
    return out;
  };
  const d: ModelDirective = {
    add: addList(r.add),
    remove: strList(r.remove),
    enable: strList(r.enable),
    disable: strList(r.disable),
    wire: wireList(r.wire),
    unwire: wireList(r.unwire),
  };
  if (
    d.add.length === 0 &&
    d.remove.length === 0 &&
    d.enable.length === 0 &&
    d.disable.length === 0 &&
    (d.wire?.length ?? 0) === 0 &&
    (d.unwire?.length ?? 0) === 0
  ) {
    return null;
  }
  return d;
}

export type WireReport = {
  wired: WireOp[];
  /** Wires a new one displaced (a pin takes one wire). */
  replaced: WireOp[];
  unwired: WireOp[];
  refused: Array<WireOp & { reason: string }>;
};

/**
 * Apply a directive's wire / unwire ops to the canvas wiring. Pure. Both
 * ends must be attached (`attachedIds` — the stack AFTER the directive's
 * adds / removes), the pins must agree, and no loop may close.
 */
export function applyWireDirective(
  wires: ModelWire[],
  d: ModelDirective,
  attachedIds: Iterable<string>,
): { next: ModelWire[]; report: WireReport } {
  const attached = new Set(attachedIds);
  const report: WireReport = { wired: [], replaced: [], unwired: [], refused: [] };
  let next = wires;
  for (const op of d.unwire ?? []) {
    const after = disconnectWire(next, op.from, op.to);
    if (after === next) report.refused.push({ ...op, reason: "no such wire" });
    else report.unwired.push(op);
    next = after;
  }
  for (const op of d.wire ?? []) {
    const refuse = (reason: string) => report.refused.push({ ...op, reason });
    if (!MODEL_BY_ID.has(op.from) || !MODEL_BY_ID.has(op.to)) {
      refuse("not in the catalog");
      continue;
    }
    if (!attached.has(op.from) || !attached.has(op.to)) {
      refuse("both models must be on the canvas");
      continue;
    }
    const pair = resolveWire(op.from, op.to);
    if (!pair) {
      refuse(`${name(op.to)} takes nothing ${name(op.from)} produces`);
      continue;
    }
    if (next.some((w) => w.source === op.from && w.target === op.to)) {
      refuse("already wired");
      continue;
    }
    const displaced = wireInto(next, op.to, pair.input.id);
    const others = displaced ? next.filter((w) => w !== displaced) : next;
    if (createsCycle(others, op.from, op.to)) {
      refuse("that wire would close a loop");
      continue;
    }
    next = connectWire(next, op.from, op.to);
    report.wired.push(op);
    if (displaced) report.replaced.push({ from: displaced.source, to: displaced.target });
  }
  return { next, report };
}

/** Human confirmation of the wire ops, "" when there were none. */
export function describeWireReport(report: WireReport): string {
  const arrow = (op: WireOp) => `${name(op.from)} → ${name(op.to)}`;
  const parts: string[] = [];
  if (report.wired.length) {
    const replaced = report.replaced.length
      ? ` (unplugging ${report.replaced.map(arrow).join(", ")})`
      : "";
    parts.push(`✔ wired ${report.wired.map(arrow).join(", ")}${replaced}`);
  }
  if (report.unwired.length) parts.push(`✔ unplugged ${report.unwired.map(arrow).join(", ")}`);
  for (const r of report.refused) parts.push(`✕ ${arrow(r)} refused: ${r.reason}`);
  return parts.join(" · ");
}

/** Apply a directive to the current stack. Pure — returns the next stack
 *  and an honest report of applied / skipped / refused ids. */
export function applyModelDirective(
  selected: SelectedModel[],
  d: ModelDirective,
): { next: SelectedModel[]; report: DirectiveReport } {
  const report: DirectiveReport = {
    added: [],
    removed: [],
    enabled: [],
    disabled: [],
    unknown: [],
    skipped: [],
  };
  let next = [...selected];
  const has = (id: string) => next.some((m) => m.id === id);

  for (const a of d.add) {
    if (!MODEL_BY_ID.has(a.id)) {
      report.unknown.push(a.id);
      continue;
    }
    if (has(a.id)) {
      report.skipped.push(a.id);
      continue;
    }
    next.push({ id: a.id, enabled: true, source: "ai", rationale: a.rationale });
    report.added.push(a.id);
  }
  for (const id of d.remove) {
    if (!MODEL_BY_ID.has(id)) {
      report.unknown.push(id);
      continue;
    }
    if (!has(id)) {
      report.skipped.push(id);
      continue;
    }
    next = next.filter((m) => m.id !== id);
    report.removed.push(id);
  }
  for (const id of d.enable) {
    if (!MODEL_BY_ID.has(id)) {
      report.unknown.push(id);
      continue;
    }
    const cur = next.find((m) => m.id === id);
    if (!cur || cur.enabled) {
      report.skipped.push(id);
      continue;
    }
    next = next.map((m) => (m.id === id ? { ...m, enabled: true } : m));
    report.enabled.push(id);
  }
  for (const id of d.disable) {
    if (!MODEL_BY_ID.has(id)) {
      report.unknown.push(id);
      continue;
    }
    const cur = next.find((m) => m.id === id);
    if (!cur || !cur.enabled) {
      report.skipped.push(id);
      continue;
    }
    next = next.map((m) => (m.id === id ? { ...m, enabled: false } : m));
    report.disabled.push(id);
  }
  return { next, report };
}

const name = (id: string) => MODEL_BY_ID.get(id)?.name ?? id;

/** Human confirmation line that replaces the fenced block in the reply. */
export function describeDirectiveReport(report: DirectiveReport): string {
  const parts: string[] = [];
  if (report.added.length) parts.push(`✔ added ${report.added.map(name).join(", ")}`);
  if (report.removed.length) parts.push(`✔ removed ${report.removed.map(name).join(", ")}`);
  if (report.enabled.length) parts.push(`✔ enabled ${report.enabled.map(name).join(", ")}`);
  if (report.disabled.length) parts.push(`✔ disabled ${report.disabled.map(name).join(", ")}`);
  if (report.skipped.length) parts.push(`— no change for ${report.skipped.map(name).join(", ")}`);
  if (report.unknown.length) {
    parts.push(`✕ not in the catalog, refused: ${report.unknown.join(", ")}`);
  }
  if (parts.length === 0) return "— stack unchanged.";
  return parts.join(" · ");
}

/** Reply text with the fenced directive replaced by the confirmation. */
export function replaceDirectiveBlock(text: string, confirmation: string): string {
  return text.replace(FENCE_RE, `**stack update:** ${confirmation}`).trim();
}

// ── deterministic chat commands ──────────────────────────────────────────────
//
// The directive protocol depends on the provider emitting correct ids — and
// small local models demonstrably lose track of their own suggestions ("add
// all of them" → re-emits the attached stack). This parser is the
// no-LLM-required path: it resolves stack commands from the user's text and
// the assistant's OWN prior replies, deterministic and instant, the same way
// Soft Data's "clean my data" bypasses the provider.

const normText = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;

/** Catalog ids mentioned in a text, by id or display name, in order. */
export function catalogIdsIn(text: string): string[] {
  const hay = normText(text);
  const out: string[] = [];
  for (const m of MODEL_CATALOG) {
    const idToken = ` ${m.id.replace(/[^a-z0-9]+/gi, " ").toLowerCase()} `;
    const nameToken = ` ${m.name.replace(/[^a-z0-9]+/gi, " ").toLowerCase()} `;
    if (hay.includes(idToken) || hay.includes(nameToken)) out.push(m.id);
  }
  return out;
}

const ADD_VERB = /\b(add|attach|include|apply|adopt|use|bring in|put)\b/;
const REMOVE_VERB = /\b(remove|drop|delete|detach|take (out|off)|get rid of)\b/;
const ENABLE_VERB = /\b(enable|turn on|switch on|activate)\b/;
const DISABLE_VERB = /\b(disable|turn off|switch off|deactivate|mute)\b/;
const ALL_MARKER =
  /\b(all( of)?( the| your| them| those| these| five| four| three| it)?|every(thing)?|those|them|these|suggested|suggestions?|recommended|recommendations?|proposed|proposals?)\b/;

/**
 * Resolve a deterministic stack command. `assistantHistory` is newest-last;
 * for "add all suggested" the ids come from the most recent assistant reply
 * that mentions catalog models NOT already attached — skipping confirmations
 * that only re-list the current stack.
 */
export function parseStackCommand(
  userText: string,
  assistantHistory: string[],
  selected: SelectedModel[],
): ModelDirective | null {
  const text = ` ${userText.toLowerCase().trim()} `;
  const attached = new Set(selected.map((m) => m.id));
  const wantsAdd = ADD_VERB.test(text);
  const wantsRemove = REMOVE_VERB.test(text);
  const wantsEnable = ENABLE_VERB.test(text);
  const wantsDisable = DISABLE_VERB.test(text);

  // "wire / connect / plug X into Y" and "unplug / disconnect X from Y".
  const unwire = /\b(?:unwire|unplug|disconnect)\b(.+?)\bfrom\b(.+)/.exec(text);
  if (unwire) {
    const from = catalogIdsIn(unwire[1])[0];
    const to = catalogIdsIn(unwire[2])[0];
    if (from && to) {
      return { add: [], remove: [], enable: [], disable: [], unwire: [{ from, to }] };
    }
  }
  const wire = /\b(?:wire|connect|plug|feed)\b(.+?)\b(?:into|to)\b(.+)/.exec(text);
  if (wire) {
    const from = catalogIdsIn(wire[1])[0];
    const to = catalogIdsIn(wire[2])[0];
    if (from && to) {
      return { add: [], remove: [], enable: [], disable: [], wire: [{ from, to }] };
    }
  }

  // "swap X for Y" / "replace X with Y" → remove X, add Y.
  const swap = /\b(?:swap|replace)\b(.+?)\b(?:for|with)\b(.+)/.exec(text);
  if (swap) {
    const from = catalogIdsIn(swap[1]);
    const to = catalogIdsIn(swap[2]);
    if (from.length > 0 && to.length > 0) {
      return { add: to.map((id) => ({ id })), remove: from, enable: [], disable: [] };
    }
  }

  const mentioned = catalogIdsIn(userText);

  // Explicit ids in the user's own message win.
  if (mentioned.length > 0 && (wantsAdd || wantsRemove || wantsEnable || wantsDisable)) {
    return {
      add: wantsAdd && !wantsRemove ? mentioned.map((id) => ({ id })) : [],
      remove: wantsRemove ? mentioned : [],
      enable: wantsEnable ? mentioned : [],
      disable: wantsDisable ? mentioned : [],
    };
  }

  // "add all (of the) suggested/recommended/them…" → mine the assistant's
  // prior replies for the suggestion set.
  if (wantsAdd && ALL_MARKER.test(text)) {
    for (let i = assistantHistory.length - 1; i >= 0; i--) {
      const fresh = catalogIdsIn(assistantHistory[i]).filter((id) => !attached.has(id));
      if (fresh.length > 0) {
        return {
          add: fresh.map((id) => ({ id, rationale: "accepted from chat suggestions" })),
          remove: [],
          enable: [],
          disable: [],
        };
      }
    }
  }

  return null;
}
