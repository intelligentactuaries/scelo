// useActuarialTableChat — one hook that gives any stage chat the actuarial
// table vocabulary:
//
//   • suggestions   the agent's read of the data AND the last prompt the
//                   user wrote (recomputed as either changes)
//   • actions       chat chips above the input — one per top suggestion;
//                   pressing one builds the table and keeps it
//   • onLocalCommand a deterministic handler for typed prompts ("build a
//                   life table at 4% from age 20 to 100", "commutation
//                   table from age and qx", "suggest tables") — answers
//                   offline, no model in the loop, and records the prompt
//                   so the suggestions can react to it
//   • contextAddendum text for the stage's system prompt teaching the LLM
//                   the ```table block, so a free-form model reply can
//                   propose a table the card then builds
//   • buildSuggestion for the Soft Data ideas strip
//
// All three workstations (soft / tools / hard) mount it, so "develop a
// particular actuarial table" works wherever the user happens to be
// typing; the Soft Data strip is just the same suggestions shown on the
// page right after an upload.

import {
  type ActuarialTableSpec,
  type Dataset,
  type TableSuggestion,
  describeTableSpec,
  parseTablePrompt,
  suggestActuarialTables,
} from "@scelo/core";
import { useCallback, useMemo, useState } from "react";
import type { ChatAction } from "./StageChatPanel";
import { buildWorkspaceTable, tableReplyMarkdown } from "./actuarialTableUi";
import { type WorkspaceTable, useScelo } from "./sceloContext";

export type TableStage = "soft" | "tools" | "hard";

const SUGGEST_RE =
  /\b(suggest|recommend|propose|what|which|any|ideas?)\b.*\b(tables?)\b|\btables? (i|we) (can|could|should) (build|make|create)|\btable ideas\b/;

export function useActuarialTableChat(stage: TableStage, dataset: Dataset | null) {
  const { addTable, tables, logEvent } = useScelo();
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);

  const suggestions = useMemo(
    () => suggestActuarialTables(dataset, lastPrompt),
    [dataset, lastPrompt],
  );

  /** Build a spec, keep it, log it, return the chat markdown. */
  const buildSpec = useCallback(
    (spec: ActuarialTableSpec, origin: WorkspaceTable["origin"], lead?: string): string => {
      let table: WorkspaceTable;
      try {
        table = buildWorkspaceTable(spec, dataset, origin);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `I couldn't build that table (${describeTableSpec(spec)}): ${msg}.${
          dataset
            ? ` The dataset has columns ${dataset.columns
                .slice(0, 12)
                .map((c) => `\`${c}\``)
                .join(
                  ", ",
                )}${dataset.columns.length > 12 ? ", …" : ""} — name the ones to use, e.g. "build a life table from \`age\` and \`qx\`".`
            : ' Load a dataset first, or ask for a parametric table ("life table on the illustrative basis at 4 %").'
        }`;
      }
      addTable(table);
      logEvent({
        stage,
        kind: "table.build",
        payload: {
          id: table.id,
          title: table.title,
          kind: table.spec.kind,
          origin,
          spec: table.spec,
        },
      });
      return tableReplyMarkdown(table, { kept: true, lead });
    },
    [addTable, dataset, logEvent, stage],
  );

  const buildSuggestion = useCallback(
    (s: TableSuggestion): string =>
      buildSpec(s.spec, "suggestion", `Built **${s.title}** from the suggestion — ${s.why}`),
    [buildSpec],
  );

  const listSuggestions = useCallback((): string => {
    if (suggestions.length === 0) {
      return dataset
        ? `I don't see an actuarial table in \`${dataset.name}\` yet — nothing reads as age + mortality, origin × development claims, tenor + rate, or a policy file. You can still ask for a parametric one: "build a life table on the illustrative Gompertz-Makeham basis at 4 % from age 20 to 110", "commutation table at 3.5 %", "net premium table for term assurance", "discount factors at a flat 5 %".`
        : `Load a dataset and I'll read it for tables. Without one I can build parametric tables — try "build a life table on the illustrative Gompertz-Makeham basis at 4 % from age 20 to 110" or "discount factors at a flat 5 % out to 40 years".`;
    }
    const lines = suggestions.map(
      (s, i) => `${i + 1}. **${s.title}** — ${s.why}\n   → prompt: _${s.prompt}_`,
    );
    return `Reading ${dataset ? `\`${dataset.name}\`` : "your prompt"}, these tables follow naturally. Send any prompt back to me (or press its chip) and I'll build it:\n\n${lines.join("\n")}`;
  }, [dataset, suggestions]);

  /**
   * Deterministic handler for the stage chat. Returns a reply to answer
   * locally, or null to let the next handler / the LLM take the message.
   * Always records the prompt so the suggestions can react to it.
   */
  const onLocalCommand = useCallback(
    (text: string): string | null => {
      const trimmed = text.trim();
      if (trimmed) setLastPrompt(trimmed);
      const t = trimmed.toLowerCase();
      if (SUGGEST_RE.test(t) && /\btables?\b/.test(t)) return listSuggestions();
      const spec = parseTablePrompt(trimmed, dataset);
      if (!spec) return null;
      return buildSpec(spec, "chat");
    },
    [buildSpec, dataset, listSuggestions],
  );

  const actions = useMemo<ChatAction[]>(
    () =>
      suggestions.slice(0, 3).map((s) => ({
        id: `table:${s.id}`,
        label: `▦ ${shortLabel(s)}`,
        hint: `${s.why}\n\nPrompt: ${s.prompt}`,
        prompt: s.prompt,
        run: () => buildSuggestion(s),
      })),
    [suggestions, buildSuggestion],
  );

  const contextAddendum = useMemo(
    () => tableProtocol(dataset, suggestions, tables),
    [dataset, suggestions, tables],
  );

  return {
    suggestions,
    actions,
    onLocalCommand,
    contextAddendum,
    buildSuggestion,
    buildSpec,
    lastPrompt,
  };
}

function shortLabel(s: TableSuggestion): string {
  switch (s.kind) {
    case "life-table":
      return "life table";
    case "commutation":
      return "commutation";
    case "annuity-assurance":
      return "annuity factors";
    case "net-premium":
      return "premium table";
    case "runoff-triangle":
      return "triangle";
    case "discount-curve":
      return "discount curve";
    case "exposure-ae":
      return "A/E table";
    case "model-points":
      return "model points";
  }
}

/** System-prompt addendum: how the model proposes a table. Kept short — it
 *  rides on every stage chat turn. */
export function tableProtocol(
  dataset: Dataset | null,
  suggestions: TableSuggestion[],
  tables: WorkspaceTable[],
): string {
  const cols = dataset ? dataset.columns.slice(0, 40).join(", ") : "(no dataset loaded)";
  const sug = suggestions.length
    ? `Tables Scelo already thinks fit this data: ${suggestions.map((s) => `${s.kind} (${s.title})`).join("; ")}.`
    : "";
  const built = tables.length
    ? `Tables already built this session: ${tables.map((t) => t.title).join("; ")}.`
    : "";
  return `
ACTUARIAL TABLES. When the user asks you to build/derive/create an actuarial table, answer with ONE fenced block tagged \`table\` containing a JSON spec, plus one or two sentences of context. Scelo builds the table deterministically from the spec against the active dataset (columns: ${cols}) and renders it as a card the user can keep. Never type the numbers yourself.
Kinds and fields:
- {"kind":"life-table","basis":B,"ages":{"from":20,"to":110},"radix":100000}
- {"kind":"commutation","basis":B,"interest":0.04,"ages":{...}}
- {"kind":"annuity-assurance","basis":B,"interest":0.04,"term":20}
- {"kind":"net-premium","basis":B,"interest":0.04,"product":"term|endowment|whole-life","ages":{"from":20,"to":65,"step":5},"terms":[10,20,30]}
- {"kind":"runoff-triangle","originColumn":"…","developmentColumn":"…" or "paymentColumn":"…","valueColumn":"…","cumulative":true}
- {"kind":"discount-curve","points":[{"tenor":1,"rate":0.03},…] or "tenorColumn"/"rateColumn" or "flatRate":0.04,"maxTenor":60}
- {"kind":"exposure-ae","ageColumn":"…","deathsColumn":"…","exposureColumn":"…","expected":B,"bandWidth":5}
- {"kind":"model-points","ageColumn":"…","sexColumn":"…","termColumn":"…","sumAssuredColumn":"…","bandWidth":5}
where basis B is one of {"kind":"qx-column","ageColumn":"…","qxColumn":"…"}, {"kind":"lx-column","ageColumn":"…","lxColumn":"…"}, {"kind":"deaths-exposure","ageColumn":"…","deathsColumn":"…","exposureColumn":"…"}, or {"kind":"gompertz-makeham"} (Scelo's illustrative A=0.00022, B=2.7e-6, c=1.124 — say so when you use it). Only name columns that exist. Interest as a decimal.
${sug} ${built}
If the user is unsure what to build, list two or three tables that fit the data with a one-line reason each and the prompt they could send.`.trim();
}
