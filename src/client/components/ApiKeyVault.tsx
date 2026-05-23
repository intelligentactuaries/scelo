import { useEffect, useState } from 'react';
import type { ProviderPrefs, ProvidersInfo } from '../../shared/types';
import { api, loadKeys, saveKeys, type CloudProvider, type StoredKeys } from '../lib/api';
import { LEGAL_JURISDICTIONS, type LegalJurisdiction } from '../../shared/constants';

const CLOUD: { id: CloudProvider; label: string; placeholder: string }[] = [
  { id: 'anthropic', label: 'Anthropic Claude', placeholder: 'sk-ant-...' },
  { id: 'openai', label: 'OpenAI', placeholder: 'sk-...' },
  { id: 'gemini', label: 'Google Gemini', placeholder: 'AIza...' },
  { id: 'hf', label: 'Hugging Face', placeholder: 'hf_...' },
];

const TIER_LABELS = {
  councilProvider: 'council',
  societyProvider: 'society',
  chatProvider: 'chat',
} as const;

type Props = {
  open: boolean;
  onClose: () => void;
  info: ProvidersInfo | null;
  onInfo: (info: ProvidersInfo) => void;
  legalJurisdiction: LegalJurisdiction;
  onLegalJurisdictionChange: (j: LegalJurisdiction) => void;
};

export function ApiKeyVault({
  open,
  onClose,
  info,
  onInfo,
  legalJurisdiction,
  onLegalJurisdictionChange,
}: Props) {
  const [keys, setKeysLocal] = useState<StoredKeys>({});
  const [prefs, setPrefsLocal] = useState<ProviderPrefs | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [testOut, setTestOut] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKeysLocal(loadKeys());
    setMsg(null);
    setTestOut(null);
  }, [open]);

  useEffect(() => {
    if (info) setPrefsLocal(info.prefs);
  }, [info]);

  if (!open || !prefs) {
    return open ? (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="muted">loading providers…</div>
        </div>
      </div>
    ) : null;
  }

  const update = (id: CloudProvider, value: string) =>
    setKeysLocal((k) => ({ ...k, [id]: value }));

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const cleaned: StoredKeys = {};
      const wire: Partial<Record<CloudProvider, string | null>> = {};
      for (const p of CLOUD) {
        const v = (keys[p.id] ?? '').trim();
        if (v) {
          cleaned[p.id] = v;
          wire[p.id] = v;
        } else {
          wire[p.id] = null;
        }
      }
      saveKeys(cleaned);
      const next = await api.setProviders({ keys: wire, prefs: prefs ?? undefined });
      onInfo(next);
      setMsg('saved');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'save failed');
    } finally {
      setBusy(false);
    }
  }

  async function refreshOllama() {
    setBusy(true);
    setMsg(null);
    try {
      const next = await api.setProviders({ refreshOllama: true });
      onInfo(next);
      setMsg('ollama refreshed');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'refresh failed');
    } finally {
      setBusy(false);
    }
  }

  async function clearCache() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.clearCache();
      setMsg(`cache cleared (${r.cleared})`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'clear failed');
    } finally {
      setBusy(false);
    }
  }

  async function testRoute(tier: 'council' | 'society' | 'chat') {
    setBusy(true);
    setMsg(null);
    setTestOut(null);
    try {
      const r = await api.test({
        tier,
        prompt: 'reply with exactly two words: hello world',
        fresh: true,
      });
      setTestOut(`[${r.provider}/${r.model} ${r.elapsedMs}ms] ${r.response.trim()}`);
    } catch (e) {
      setTestOut(`ERR: ${e instanceof Error ? e.message : 'failed'}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="panel-label">settings — providers + keys</div>
          <button className="ghost-btn" onClick={onClose}>
            close
          </button>
        </div>

        <div className="modal-body">
          <section className="modal-section">
            <div className="panel-label">cloud api keys</div>
            <div className="muted small">
              kept in browser localStorage; pushed to the local Bun server in memory only — never
              written to disk, never logged.
            </div>
            <div className="key-grid">
              {CLOUD.map((p) => (
                <label key={p.id} className="key-row">
                  <div className="key-label">
                    <span>{p.label}</span>
                    <span className={info?.configured[p.id] ? 'status-ok' : 'muted'}>
                      {info?.configured[p.id] ? 'configured' : 'empty'}
                    </span>
                  </div>
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder={p.placeholder}
                    value={keys[p.id] ?? ''}
                    onChange={(e) => update(p.id, e.target.value)}
                  />
                  <input
                    type="text"
                    placeholder={`model override (e.g. ${
                      p.id === 'anthropic'
                        ? 'claude-sonnet-4-6'
                        : p.id === 'openai'
                          ? 'gpt-4o-mini'
                          : p.id === 'gemini'
                            ? 'gemini-2.0-flash'
                            : 'meta-llama/Llama-3.1-8B-Instruct'
                    })`}
                    value={prefs.models?.[p.id] ?? ''}
                    onChange={(e) =>
                      setPrefsLocal((s) =>
                        s
                          ? {
                              ...s,
                              models: { ...(s.models ?? {}), [p.id]: e.target.value || undefined },
                            }
                          : s,
                      )
                    }
                  />
                </label>
              ))}
            </div>
          </section>

          <section className="modal-section">
            <div className="panel-label">ollama</div>
            <div className="ollama-row">
              <div>
                <div className="muted small">selected</div>
                <div>{info?.ollamaSelected ?? '— none —'}</div>
              </div>
              <div>
                <div className="muted small">available</div>
                <div>{info?.ollamaModels.length ?? 0}</div>
              </div>
              <select
                value={prefs.models?.ollama ?? ''}
                onChange={(e) =>
                  setPrefsLocal((s) =>
                    s
                      ? {
                          ...s,
                          models: { ...(s.models ?? {}), ollama: e.target.value || undefined },
                        }
                      : s,
                  )
                }
              >
                <option value="">auto (largest preferred)</option>
                {(info?.ollamaModels ?? []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <button className="ghost-btn" onClick={refreshOllama} disabled={busy}>
                refresh
              </button>
            </div>
          </section>

          <section className="modal-section">
            <div className="panel-label">provider preference per tier</div>
            <div className="tier-grid">
              {(['councilProvider', 'societyProvider', 'chatProvider'] as const).map((k) => (
                <label key={k}>
                  <div className="muted small">{TIER_LABELS[k]}</div>
                  <select
                    value={prefs[k]}
                    onChange={(e) =>
                      setPrefsLocal((s) =>
                        s ? { ...s, [k]: e.target.value as ProviderPrefs[typeof k] } : s,
                      )
                    }
                  >
                    <option value="auto">auto</option>
                    <option value="anthropic">anthropic</option>
                    <option value="openai">openai</option>
                    <option value="gemini">gemini</option>
                    <option value="hf">huggingface</option>
                    <option value="ollama">ollama</option>
                  </select>
                </label>
              ))}
            </div>
          </section>

          <section className="modal-section">
            <div className="panel-label">deliberation defaults</div>
            <label className="jur-row">
              <div className="muted small">legal jurisdiction (affects Lawyer persona & justifications)</div>
              <select
                value={legalJurisdiction}
                onChange={(e) => onLegalJurisdictionChange(e.target.value as LegalJurisdiction)}
              >
                {LEGAL_JURISDICTIONS.map((j) => (
                  <option key={j} value={j}>
                    {j}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="modal-section">
            <div className="panel-label">end-to-end test</div>
            <div className="muted small">
              sends a one-shot "hello world" through the router; uses fresh=true so cache is
              bypassed.
            </div>
            <div className="test-row">
              <button className="ghost-btn" onClick={() => testRoute('society')} disabled={busy}>
                test society (ollama)
              </button>
              <button className="ghost-btn" onClick={() => testRoute('council')} disabled={busy}>
                test council (cloud)
              </button>
              <button className="ghost-btn" onClick={clearCache} disabled={busy}>
                clear cache
              </button>
            </div>
            {testOut && <pre className="test-out">{testOut}</pre>}
          </section>
        </div>

        <div className="modal-footer">
          {msg && <span className="muted small">{msg}</span>}
          <button className="primary-btn" onClick={save} disabled={busy}>
            save
          </button>
        </div>
      </div>
    </div>
  );
}
