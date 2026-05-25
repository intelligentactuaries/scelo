// First-run AI provider onboarding modal. Mounted globally from App
// so the user sees it whether they land on /, /workspace, or
// /welcome on first launch. Gated by lib/firstRunAi so it never
// fires twice and never fires for users who already have Ollama
// running or a provider configured.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  markFirstRunPromptShown,
  shouldShowFirstRunPrompt,
} from "../lib/firstRunAi";

export default function FirstRunAIPrompt() {
  const [visible, setVisible] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    void shouldShowFirstRunPrompt().then((show) => {
      if (!cancelled && show) setVisible(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    markFirstRunPromptShown();
    setVisible(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="first-run-ai-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/85 p-4"
    >
      <div className="w-full max-w-md rounded border border-border bg-bg-2 p-5 shadow-lg">
        <h2 id="first-run-ai-title" className="font-display text-lg text-fg">
          Pick an AI brain
        </h2>
        <p className="mt-2 text-sm text-fg-mute">
          Scelo's chat + workspace AI panel ship with three paths. Pick the
          one that matches how you want to work; you can always change
          later from Settings : AI.
        </p>
        <ul className="mt-4 space-y-3 text-sm">
          <li className="rounded border border-border bg-bg p-3">
            <h3 className="text-fg">Ollama, local + free (recommended)</h3>
            <p className="mt-1 text-fg-mute">
              Runs the LLM on this machine. No API key, no spend, works
              offline once a model is pulled. Scelo's default.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <a
                href="https://ollama.com/download"
                target="_blank"
                rel="noreferrer noopener"
                className="rounded border border-border bg-bg-2 px-2 py-1 text-xs text-fg hover:border-primary"
                onClick={dismiss}
              >
                Download Ollama →
              </a>
              <button
                type="button"
                onClick={dismiss}
                className="rounded border border-border bg-bg-2 px-2 py-1 text-xs text-fg-mute hover:text-fg"
              >
                I'll set it up later
              </button>
            </div>
          </li>
          <li className="rounded border border-border bg-bg p-3">
            <h3 className="text-fg">Bring your own API key</h3>
            <p className="mt-1 text-fg-mute">
              Claude, OpenAI, Gemini, or any OpenAI-compatible endpoint. Keys
              live in the OS keychain (macOS Keychain / Windows DPAPI /
              libsecret) when running inside Scelo IDE.
            </p>
            <button
              type="button"
              onClick={() => {
                markFirstRunPromptShown();
                setVisible(false);
                navigate("/settings/ai");
              }}
              className="mt-2 rounded border border-fg bg-fg px-2 py-1 text-xs text-bg hover:opacity-90"
            >
              Open Settings : AI
            </button>
          </li>
        </ul>
        <div className="mt-4 flex items-center justify-end gap-3 text-xs">
          <button
            type="button"
            onClick={dismiss}
            className="text-fg-mute hover:text-fg"
          >
            skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
