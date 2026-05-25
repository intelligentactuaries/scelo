// AI panel events. Two flavours:
//   * "open"   — toggle the workspace AI panel visible. Used by the
//                 Cmd-Shift-A shortcut and the palette command.
//   * "prompt" — open the panel + enqueue a prompt the panel should
//                 either pre-fill or auto-send. Used by "Send selection
//                 to AI" (Cmd-L) and any future templated commands.
//
// Mirrors toastBus / lspBus / gitBus / terminalBus shape: emit side
// has no React deps.

export interface AiPrompt {
  /** Pre-filled text in the input box. */
  text: string;
  /** When true, send immediately instead of waiting for the user to
   *  hit Enter. The current default behaviour for "Send selection". */
  autoSend?: boolean;
}

type OpenListener = () => void;
type PromptListener = (p: AiPrompt) => void;

const openListeners = new Set<OpenListener>();
const promptListeners = new Set<PromptListener>();

export function emitOpenAiPanel(): void {
  for (const fn of openListeners) fn();
}

export function emitAiPrompt(p: AiPrompt): void {
  // The contract is "open + enqueue", so callers don't need to fire two events.
  emitOpenAiPanel();
  for (const fn of promptListeners) fn(p);
}

export function subscribeOpenAiPanel(fn: OpenListener): () => void {
  openListeners.add(fn);
  return () => {
    openListeners.delete(fn);
  };
}

export function subscribeAiPrompt(fn: PromptListener): () => void {
  promptListeners.add(fn);
  return () => {
    promptListeners.delete(fn);
  };
}
