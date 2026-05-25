// StatusBar — single 24px row pinned to the bottom of the /workspace
// shell. Surfaces the same handful of facts a VS Code user expects
// to glance at: language mode, line count, active AI provider, LSP
// health, and the workspace path.
//
// Pure subscriber: takes the file path + caret line + buffer string
// from the workspace shell, derives everything else from existing
// state (getActiveProviderId, lspBus). The shell doesn't need to
// know this component exists beyond mounting it.

import { useEffect, useMemo, useState } from "react";
import {
  getActiveProviderId,
  getProviderConfig,
  PROVIDER_CATALOG,
  type ProviderId,
} from "../../lib/aiProviders";
import { getGitStatus, subscribeGit } from "../../lib/gitBus";
import { languageFor } from "../../lib/languageFor";
import {
  getLspStatus,
  subscribeLspStatus,
  type LspStatus,
} from "../../lib/lspBus";
import { emitToast } from "../../lib/toastBus";
import type { GitStatus, LspLang } from "../../lib/sceloIDE";

interface Props {
  workspacePath: string | null;
  activePath: string | null;
  caretLine: number | null;
  activeBuffer: string;
  terminalVisible: boolean;
  onToggleTerminal: () => void;
}

export default function StatusBar({
  workspacePath,
  activePath,
  caretLine,
  activeBuffer,
  terminalVisible,
  onToggleTerminal,
}: Props) {
  const langMode = languageFor(activePath) ?? "plaintext";
  const langLabel = LANG_LABELS[langMode] ?? langMode;

  const lineCount = useMemo(
    () => (activeBuffer ? activeBuffer.split("\n").length : 0),
    [activeBuffer],
  );

  const ai = useActiveProviderSummary();
  const pythonStatus = useLspStatus("python");
  const rStatus = useLspStatus("r");
  const git = useGitStatusSnapshot();

  return (
    <footer
      className="flex h-6 shrink-0 items-center justify-between gap-3 border-t border-border bg-bg-2 px-3 text-[11px] text-fg-mute"
      role="contentinfo"
      aria-label="Workspace status"
    >
      <div className="flex items-center gap-3 truncate">
        {workspacePath && (
          <button
            type="button"
            className="truncate font-mono hover:text-fg"
            title={`${workspacePath} — click to copy`}
            onClick={() => copyToClipboard(workspacePath)}
          >
            {truncatePath(workspacePath)}
          </button>
        )}
        {git && git.isRepo && (
          <span title={branchTitle(git)} className="text-fg-mute">
            ⌥ {git.branch ?? "(detached)"}
            {git.upstream && (
              <span className="ml-1">
                ↑{git.ahead} ↓{git.behind}
              </span>
            )}
            {git.files.length > 0 && (
              <span className="ml-1 text-warn">●{git.files.length}</span>
            )}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 whitespace-nowrap">
        <button
          type="button"
          onClick={onToggleTerminal}
          title={
            terminalVisible
              ? "Hide the terminal (Ctrl-`) — sessions keep running in the background"
              : "Show the terminal (Ctrl-`)"
          }
          className="text-fg-mute transition hover:text-fg"
        >
          {terminalVisible ? "▾ terminal" : "▴ terminal"}
        </button>
        {activePath && (
          <>
            <span title="Lines in active buffer">Ln {caretLine ?? "—"}/{lineCount}</span>
            <span title="Language mode">{langLabel}</span>
          </>
        )}
        <LspDot lang="python" status={pythonStatus} label="Pyright" />
        <LspDot lang="r" status={rStatus} label="R-LSP" />
        <span title="Active AI provider">
          <span className="text-fg-mute">AI:</span>{" "}
          <span className="text-fg">{ai}</span>
        </span>
      </div>
    </footer>
  );
}

function LspDot({
  lang,
  status,
  label,
}: {
  lang: LspLang;
  status: LspStatus;
  label: string;
}) {
  const color =
    status === "live"
      ? "bg-primary"
      : status === "starting"
        ? "bg-warn"
        : status === "error"
          ? "bg-error"
          : "bg-fg-dim";
  const title = `${label} (${lang}): ${status}`;
  return (
    <span className="flex items-center gap-1" title={title}>
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function useActiveProviderSummary(): string {
  const [label, setLabel] = useState<string>(() => formatProvider(getActiveProviderId(), null));
  useEffect(() => {
    let cancelled = false;
    const id = getActiveProviderId();
    void getProviderConfig(id).then((cfg) => {
      if (!cancelled) setLabel(formatProvider(id, cfg?.model ?? null));
    });
    // The provider can change from /settings/ai. Re-read on storage
    // events so the status bar updates without a full reload.
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key.startsWith("ia.aiProvider.")) {
        const next = getActiveProviderId();
        void getProviderConfig(next).then((cfg) => {
          if (!cancelled) setLabel(formatProvider(next, cfg?.model ?? null));
        });
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      cancelled = true;
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return label;
}

function useGitStatusSnapshot(): GitStatus | null {
  const [s, setS] = useState<GitStatus | null>(() => getGitStatus());
  useEffect(() => subscribeGit(setS), []);
  return s;
}

function branchTitle(g: GitStatus): string {
  const parts: string[] = [];
  parts.push(`branch: ${g.branch ?? "(detached)"}`);
  if (g.upstream) parts.push(`upstream: ${g.upstream}`);
  if (g.upstream) parts.push(`ahead ${g.ahead}, behind ${g.behind}`);
  parts.push(
    g.files.length === 0
      ? "working tree clean"
      : `${g.files.length} change${g.files.length === 1 ? "" : "s"}`,
  );
  return parts.join(" · ");
}

function useLspStatus(lang: LspLang): LspStatus {
  const [s, setS] = useState<LspStatus>(() => getLspStatus(lang));
  useEffect(
    () =>
      subscribeLspStatus((e) => {
        if (e.lang === lang) setS(e.status);
      }),
    [lang],
  );
  return s;
}

function formatProvider(id: ProviderId, model: string | null): string {
  const desc = PROVIDER_CATALOG.find((p) => p.id === id);
  const shortLabel = desc?.label.split(" ")[0] ?? id;
  const m = model ?? desc?.defaultModel;
  return m ? `${shortLabel}: ${m}` : shortLabel;
}

/** Display only the last two path segments so a long path doesn't push
 *  the right-side cells off-screen on narrow windows. */
function truncatePath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join("/")}`;
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    emitToast(`Copied: ${text}`, "info");
  } catch {
    emitToast("Copy failed; clipboard unavailable.", "error");
  }
}

const LANG_LABELS: Record<string, string> = {
  python: "Python",
  r: "R",
  json: "JSON",
  markdown: "Markdown",
  yaml: "YAML",
  ini: "TOML",
  sql: "SQL",
  typescript: "TypeScript",
  javascript: "JavaScript",
  html: "HTML",
  css: "CSS",
  shell: "Shell",
  plaintext: "Plain Text",
};
