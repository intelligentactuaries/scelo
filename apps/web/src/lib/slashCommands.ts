// Slash command registry for the web chat input. Each command has a name,
// short hint, and an executor that the chat invokes when the user submits
// a line beginning with that command. Some commands resolve locally
// (clear, export, dashboards, help); others are forwarded to a backend
// query (wiki, regulatory).

export type SlashCommand = {
  name: string; // includes the leading slash, e.g. "/help"
  hint: string;
  // Whether to send the rest of the line to the orchestrator after
  // executing the local handler. Used by /wiki and /regulatory.
  forwardToOrchestrator?: boolean;
};

export const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  { name: "/help", hint: "show usage tips" },
  { name: "/dashboards", hint: "open the dashboards landing page" },
  { name: "/clear", hint: "clear the current conversation" },
  { name: "/export", hint: "download the conversation as JSON" },
  { name: "/wiki", hint: "search the wiki", forwardToOrchestrator: true },
  {
    name: "/regulatory",
    hint: "search regulatory corpus",
    forwardToOrchestrator: true,
  },
];

// Parse a draft string. Returns the command if the draft starts with one
// (token-bounded, so "/exporters" doesn't match "/export").
export function parseCommand(draft: string): SlashCommand | null {
  const trimmed = draft.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const space = trimmed.indexOf(" ");
  const head = space < 0 ? trimmed : trimmed.slice(0, space);
  return SLASH_COMMANDS.find((c) => c.name === head) ?? null;
}

export function commandRest(draft: string): string {
  const trimmed = draft.trimStart();
  const space = trimmed.indexOf(" ");
  return space < 0 ? "" : trimmed.slice(space + 1).trim();
}

// Filter for the autocomplete dropdown.
export function suggest(draft: string): SlashCommand[] {
  const trimmed = draft.trimStart();
  if (!trimmed.startsWith("/")) return [];
  const head = trimmed.split(" ")[0].toLowerCase();
  if (head.length === 1) return [...SLASH_COMMANDS];
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(head));
}
