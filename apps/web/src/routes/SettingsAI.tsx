// /settings/ai — AI providers panel.
//
// Lets the user choose which LLM Scelo's chat & orchestrator talk to:
// Ollama (default, local), Anthropic, OpenAI, Gemini, or any
// OpenAI-compatible endpoint (LM Studio, vLLM, Together, Groq, …).
// Keys are stored encrypted in the OS keychain when running inside the
// Scelo IDE; in a regular browser they fall back to localStorage with a
// visible warning.
//
// Default stays Ollama — selecting a hosted provider is opt-in and
// affects every chat call from this device until changed back.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  PROVIDER_CATALOG,
  type ProviderConfig,
  type ProviderDescriptor,
  type ProviderId,
  clearProviderConfig,
  getActiveProviderId,
  getProviderConfig,
  hasLocalLlmBridge,
  isSecureStore,
  llmChatWithConfig,
  setActiveProviderId,
  setProviderConfig,
} from "../lib/aiProviders";
import { API_BASE } from "../lib/api";
import { isDesktopIDE } from "../lib/sceloIDE";
import { emitToast } from "../lib/toastBus";

type SaveStatus = "idle" | "saving" | "saved" | "error";
type TestStatus = "idle" | "testing" | { ok: true; reply: string } | { ok: false; error: string };

export default function SettingsAI() {
  const [activeId, setActiveId] = useState<ProviderId>(() => getActiveProviderId());
  const [secure, setSecure] = useState<boolean | null>(null);
  const [configs, setConfigs] = useState<Record<ProviderId, ProviderConfig | null>>(
    {} as Record<ProviderId, ProviderConfig | null>,
  );
  const [draft, setDraft] = useState<Record<ProviderId, Partial<ProviderConfig>>>(
    {} as Record<ProviderId, Partial<ProviderConfig>>,
  );
  const [save, setSave] = useState<Record<ProviderId, SaveStatus>>(
    {} as Record<ProviderId, SaveStatus>,
  );
  const [test, setTest] = useState<Record<ProviderId, TestStatus>>(
    {} as Record<ProviderId, TestStatus>,
  );

  useEffect(() => {
    isSecureStore().then(setSecure);
    Promise.all(
      PROVIDER_CATALOG.map((p) =>
        getProviderConfig(p.id).then((cfg) => [p.id, cfg] as const),
      ),
    ).then((entries) => {
      const next = Object.fromEntries(entries) as Record<ProviderId, ProviderConfig | null>;
      setConfigs(next);
    });
  }, []);

  const onSetActive = (id: ProviderId) => {
    setActiveProviderId(id);
    setActiveId(id);
  };

  const onSave = async (desc: ProviderDescriptor) => {
    const d = draft[desc.id] ?? {};
    const existing = configs[desc.id];
    const cfg: ProviderConfig = {
      id: desc.id,
      // Preserve a previously-saved key/model/baseUrl when the field is left
      // blank — re-saving (e.g. to update just the key) must not silently
      // reset the model back to the provider default. Only fall back to the
      // hardcoded default when nothing has ever been set.
      apiKey: d.apiKey || existing?.apiKey || "",
      model: d.model || existing?.model || desc.defaultModel,
      baseUrl: desc.needsBaseUrl
        ? d.baseUrl || existing?.baseUrl || desc.baseUrlPlaceholder
        : undefined,
    };
    setSave((s) => ({ ...s, [desc.id]: "saving" }));
    try {
      await setProviderConfig(cfg);
      setConfigs((c) => ({ ...c, [desc.id]: cfg }));
      setDraft((c) => ({ ...c, [desc.id]: {} }));
      setSave((s) => ({ ...s, [desc.id]: "saved" }));
      setTimeout(() => setSave((s) => ({ ...s, [desc.id]: "idle" })), 1500);
      emitToast(`${desc.label}: saved.`, "success");
    } catch (e) {
      setSave((s) => ({ ...s, [desc.id]: "error" }));
      emitToast(
        `${desc.label}: save failed — ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    }
  };

  const onClear = async (id: ProviderId) => {
    await clearProviderConfig(id);
    setConfigs((c) => ({ ...c, [id]: null }));
    if (activeId === id) onSetActive("ollama");
  };

  // Reset every provider back to the original state: no keys/models stored,
  // active provider back to the local Ollama default. Stored config otherwise
  // persists across launches (keychain + localStorage), so this is the only
  // thing that wipes it — the user configures once and resets deliberately.
  const onResetAll = async () => {
    const ok =
      typeof window === "undefined" ||
      window.confirm(
        "Reset all AI providers to defaults? This clears every saved key and model and switches back to the local Ollama default.",
      );
    if (!ok) return;
    await Promise.all(PROVIDER_CATALOG.map((p) => clearProviderConfig(p.id)));
    setConfigs({} as Record<ProviderId, ProviderConfig | null>);
    setDraft({} as Record<ProviderId, Partial<ProviderConfig>>);
    setTest({} as Record<ProviderId, TestStatus>);
    onSetActive("ollama");
    emitToast("AI providers reset to defaults.", "success");
  };

  const onTest = async (desc: ProviderDescriptor) => {
    setTest((t) => ({ ...t, [desc.id]: "testing" }));
    const cfg = configs[desc.id] ?? null;
    const d = draft[desc.id] ?? {};
    const apiKey = d.apiKey ?? cfg?.apiKey ?? "";
    const model = d.model || cfg?.model || desc.defaultModel;
    const baseUrl = desc.needsBaseUrl
      ? d.baseUrl || cfg?.baseUrl || desc.baseUrlPlaceholder
      : undefined;
    try {
      // Desktop build: call the provider directly through the main-process
      // bridge — there is no orchestrator backend to proxy through, and the
      // old /api path returned the SPA's index.html (the "<!doctype …> is not
      // valid JSON" failure).
      if (hasLocalLlmBridge()) {
        const res = await llmChatWithConfig(
          { id: desc.id, apiKey, model, baseUrl },
          [{ role: "user", content: "Reply with the single word: ok" }],
          // Generous budget: reasoning models (gpt-oss, R1, …) spend tokens
          // thinking before they emit any visible content, so a tiny cap
          // comes back blank even when the connection is fine.
          { maxTokens: 512 },
        );
        const reply = (res.text ?? "").trim();
        setTest((t) => ({
          ...t,
          [desc.id]: res.ok
            ? reply
              ? { ok: true, reply }
              : // Connection worked but the model returned no text — say so
                // plainly rather than showing a cryptic "<empty>".
                { ok: true, reply: "(connected — model returned no text)" }
            : { ok: false, error: res.error ?? "unknown error" },
        }));
        if (!res.ok) {
          emitToast(`${desc.label}: test connection failed — ${res.error ?? "unknown error"}`, "error");
        }
        return;
      }
      const r = await fetch(`${API_BASE}/agents/orchestrator/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: desc.id, api_key: apiKey, model, base_url: baseUrl }),
      });
      const body = (await r.json()) as { ok: boolean; reply?: string; error?: string };
      setTest((t) => ({
        ...t,
        [desc.id]: body.ok
          ? { ok: true, reply: body.reply ?? "<empty>" }
          : { ok: false, error: body.error ?? "unknown error" },
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTest((t) => ({ ...t, [desc.id]: { ok: false, error: msg } }));
      emitToast(`${desc.label}: test connection failed — ${msg}`, "error");
    }
  };

  return (
    <div className="mx-auto max-w-4xl p-8 font-sans text-fg">
      <header className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wider text-fg-mute">
              settings · AI providers
            </div>
            <h1 className="text-2xl font-medium">Bring your own AI</h1>
          </div>
          <button
            type="button"
            onClick={onResetAll}
            className="ia-btn ia-btn-md ia-btn-secondary shrink-0"
            title="Clear all saved keys/models and switch back to the local Ollama default. Your settings otherwise persist across launches."
          >
            reset to defaults
          </button>
        </div>
        <p className="mt-1 text-sm text-fg-mute">
          Default is <strong>Ollama</strong> running on this machine: no key, no spend, no
          network. Switch to a hosted provider (Anthropic, OpenAI, Gemini) or any
          OpenAI-compatible endpoint by entering a key below.
        </p>
        <p className="mt-2 text-xs text-fg-mute">
          {secure === null
            ? "Checking key-storage backend…"
            : secure
              ? "Keys are encrypted at rest in the OS keychain (Keychain on macOS, DPAPI on Windows, libsecret on Linux)."
              : isDesktopIDE()
                ? "OS keychain not available on this host (Linux without libsecret?). Keys are stored on disk in plain text."
                : "You are not running Scelo IDE. Keys will be stored in this browser's localStorage — convenient but visible to any script on this origin."}
        </p>
      </header>

      <ul className="flex flex-col gap-4">
        {PROVIDER_CATALOG.map((desc) => (
          <li key={desc.id}>
            <ProviderCard
              desc={desc}
              isActive={activeId === desc.id}
              cfg={configs[desc.id] ?? null}
              draft={draft[desc.id] ?? {}}
              save={save[desc.id] ?? "idle"}
              test={test[desc.id] ?? "idle"}
              onSetActive={() => onSetActive(desc.id)}
              onDraft={(patch) =>
                setDraft((d) => ({ ...d, [desc.id]: { ...(d[desc.id] ?? {}), ...patch } }))
              }
              onSave={() => onSave(desc)}
              onClear={() => onClear(desc.id)}
              onTest={() => onTest(desc)}
            />
          </li>
        ))}
      </ul>

      {/* Usage tally — server-side per-provider per-day. */}
      <UsageSection />

      {/* Auto-update channel — IDE-only setting. */}
      {isDesktopIDE() && <UpdateChannelSection />}

      <div className="mt-8 flex gap-2">
        <Link
          to="/"
          className="ia-btn ia-btn-md ia-btn-secondary"
        >
          ← back to chat
        </Link>
        {isDesktopIDE() && (
          <Link
            to="/workspace"
            className="ia-btn ia-btn-md ia-btn-secondary"
          >
            open workspace →
          </Link>
        )}
      </div>
    </div>
  );
}

type UsageDay = {
  calls: number;
  tools: number;
  total_duration_ms: number;
  input_tokens?: number;
  output_tokens?: number;
  usd?: number;
};
type Usage = Record<string, Record<string, UsageDay>>;

function UsageSection() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/agents/orchestrator/usage`);
      if (r.ok) setUsage((await r.json()) as Usage);
    } catch {
      // ignore — backend may be down
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const reset = async () => {
    await fetch(`${API_BASE}/agents/orchestrator/usage`, { method: "DELETE" });
    await load();
  };
  if (!usage) return null;
  const today = new Date().toISOString().slice(0, 10);
  const providers = Object.keys(usage).sort();
  const empty = providers.length === 0;
  return (
    <section className="mt-6 rounded-md border border-border bg-bg-2 p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-fg-mute">
            provider usage · per day
          </div>
          <div className="text-[10px] text-fg-mute">
            Counts each orchestrator stream. Token-level cost tracking lands
            in Phase 5 once upstream usage headers are surfaced.
          </div>
        </div>
        <button
          type="button"
          onClick={reset}
          disabled={empty}
          className="ia-btn ia-btn-sm ia-btn-ghost"
        >
          reset
        </button>
      </div>
      {empty ? (
        <div className="text-[11px] text-fg-mute">no calls recorded yet</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-fg-mute">
            <tr>
              <th className="px-1 py-1 text-left">provider</th>
              <th className="px-1 py-1 text-right">today calls</th>
              <th className="px-1 py-1 text-right">tokens in / out</th>
              <th className="px-1 py-1 text-right">today USD</th>
              <th className="px-1 py-1 text-right">7-day USD</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => {
              const days = usage[p] ?? {};
              const t = days[today] ?? {
                calls: 0,
                tools: 0,
                total_duration_ms: 0,
                input_tokens: 0,
                output_tokens: 0,
                usd: 0,
              };
              const last7Usd = Object.entries(days)
                .filter(([d]) => withinDays(d, 7))
                .reduce((s, [, v]) => s + (v.usd ?? 0), 0);
              const inTok = t.input_tokens ?? 0;
              const outTok = t.output_tokens ?? 0;
              const usd = t.usd ?? 0;
              return (
                <tr key={p} className="border-t border-border/60">
                  <td className="px-1 py-1 font-mono">{p}</td>
                  <td className="px-1 py-1 text-right">{t.calls}</td>
                  <td className="px-1 py-1 text-right font-mono">
                    {fmtK(inTok)} / {fmtK(outTok)}
                  </td>
                  <td className="px-1 py-1 text-right">
                    {usd > 0 ? `$${usd.toFixed(4)}` : "—"}
                  </td>
                  <td className="px-1 py-1 text-right">
                    {last7Usd > 0 ? `$${last7Usd.toFixed(2)}` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

function withinDays(day: string, n: number): boolean {
  const d = Date.parse(day + "T00:00:00Z");
  if (Number.isNaN(d)) return false;
  return Date.now() - d <= n * 24 * 60 * 60 * 1000;
}

function UpdateChannelSection() {
  const [channel, setChannel] = useState<"latest" | "beta" | null>(null);
  useEffect(() => {
    window.scelo!.updater.getChannel().then((c) => setChannel(c.channel));
  }, []);
  if (channel === null) return null;
  const onChange = async (next: "latest" | "beta") => {
    const r = await window.scelo!.updater.setChannel(next);
    setChannel(r.channel as "latest" | "beta");
  };
  return (
    <section className="mt-6 rounded-md border border-border bg-bg-2 p-4">
      <div className="text-xs uppercase tracking-wider text-fg-mute">
        auto-update channel
      </div>
      <div className="mt-2 flex items-center gap-2 text-sm">
        {(["latest", "beta"] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            className={`rounded border px-3 py-1 text-xs ${
              channel === c
                ? "border-fg bg-fg text-bg"
                : "border-border bg-bg hover:border-fg"
            }`}
          >
            {c === "latest" ? "stable" : "beta"}
          </button>
        ))}
        <span className="text-[10px] text-fg-mute">
          {channel === "beta"
            ? "Includes pre-release builds tagged scelo-ide-vX.Y.Z-beta.N."
            : "Only signed stable releases."}
        </span>
      </div>
    </section>
  );
}

function ProviderCard({
  desc,
  isActive,
  cfg,
  draft,
  save,
  test,
  onSetActive,
  onDraft,
  onSave,
  onClear,
  onTest,
}: {
  desc: ProviderDescriptor;
  isActive: boolean;
  cfg: ProviderConfig | null;
  draft: Partial<ProviderConfig>;
  save: SaveStatus;
  test: TestStatus;
  onSetActive: () => void;
  onDraft: (patch: Partial<ProviderConfig>) => void;
  onSave: () => void;
  onClear: () => void;
  onTest: () => void;
}) {
  const configured = !desc.needsKey || !!cfg?.apiKey;
  return (
    <div
      className={`rounded-md border p-4 ${
        isActive ? "border-fg bg-bg" : "border-border bg-bg-2"
      }`}
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{desc.label}</div>
          <div className="text-xs text-fg-mute">{desc.blurb}</div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`text-xs ${
              configured ? "text-consensus" : "text-fg-mute"
            }`}
          >
            {configured ? "configured" : "not configured"}
          </span>
          <button
            type="button"
            onClick={onSetActive}
            disabled={!configured}
            className={`rounded border px-3 py-1 text-xs ${
              isActive
                ? "border-fg bg-fg text-bg"
                : configured
                  ? "border-border bg-bg hover:border-fg"
                  : "border-border bg-bg text-fg-mute opacity-50"
            }`}
          >
            {isActive ? "active" : "use this"}
          </button>
        </div>
      </div>

      {desc.needsKey && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_180px]">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-fg-mute">
              API key{" "}
              <a
                href={desc.keyHelpUrl}
                target="_blank"
                rel="noreferrer"
                className="text-link underline"
              >
                where to get one
              </a>
            </span>
            <input
              type="password"
              autoComplete="off"
              placeholder={cfg?.apiKey ? `current: ${cfg.apiKey.slice(0, 4)}…${cfg.apiKey.slice(-4)}` : "sk-…"}
              value={draft.apiKey ?? ""}
              onChange={(e) => onDraft({ apiKey: e.target.value })}
              className="rounded border border-border bg-bg px-2 py-1 font-mono text-xs"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-fg-mute">model</span>
            <input
              type="text"
              placeholder={desc.defaultModel}
              value={draft.model ?? cfg?.model ?? ""}
              onChange={(e) => onDraft({ model: e.target.value })}
              className="rounded border border-border bg-bg px-2 py-1 font-mono text-xs"
              title={desc.modelHint}
            />
          </label>
          {desc.needsBaseUrl && (
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-[10px] uppercase tracking-wider text-fg-mute">base URL</span>
              <input
                type="text"
                placeholder={desc.baseUrlPlaceholder}
                value={draft.baseUrl ?? cfg?.baseUrl ?? ""}
                onChange={(e) => onDraft({ baseUrl: e.target.value })}
                className="rounded border border-border bg-bg px-2 py-1 font-mono text-xs"
              />
            </label>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {desc.needsKey && (
          <>
            <button
              type="button"
              onClick={onSave}
              disabled={save === "saving"}
              className="ia-btn ia-btn-md ia-btn-primary"
            >
              {save === "saving"
                ? "saving…"
                : save === "saved"
                  ? "saved ✓"
                  : save === "error"
                    ? "save failed"
                    : "save"}
            </button>
            <button
              type="button"
              onClick={onTest}
              disabled={test === "testing"}
              className="ia-btn ia-btn-md ia-btn-secondary"
            >
              {test === "testing" ? "testing…" : "test connection"}
            </button>
            {cfg?.apiKey && (
              <button
                type="button"
                onClick={onClear}
                className="ia-btn ia-btn-md ia-btn-danger"
              >
                clear
              </button>
            )}
          </>
        )}
        {!desc.needsKey && (
          <>
            {desc.testable && (
              <button
                type="button"
                onClick={onTest}
                disabled={test === "testing"}
                className="ia-btn ia-btn-md ia-btn-secondary"
              >
                {test === "testing" ? "testing…" : "test connection"}
              </button>
            )}
            <span className="text-xs text-fg-mute">
              {desc.id === "claude_code"
                ? "No key needed — reuses your Claude Code login. Requires the `claude` CLI installed and signed in on this machine (desktop app only)."
                : "Default provider. Edit IA_AGENT_PROVIDER in the API env to remap globally."}
            </span>
          </>
        )}
      </div>

      {test && typeof test !== "string" && (
        <div
          className={`mt-3 rounded border p-2 text-xs ${
            test.ok
              ? "border-consensus/40 bg-consensus/10 text-consensus"
              : "border-adversarial/40 bg-adversarial/10 text-adversarial"
          }`}
        >
          {test.ok
            ? `OK — model replied: ${JSON.stringify(test.reply)}`
            : `failed — ${test.error}`}
        </div>
      )}
    </div>
  );
}
