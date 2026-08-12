import { useEffect, useState } from 'react';
import type { ProviderPrefs, ProvidersInfo } from '../../shared/types';
import { api, loadKeys, saveKeys, savePrefs, type CloudProvider, type StoredKeys } from '../lib/api';
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
  // Whether this form holds edits that have not been pushed to the server.
  // Drives both guards below: what the footer is allowed to claim, and
  // whether a server refresh may overwrite the fields.
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKeysLocal(loadKeys());
    setMsg(null);
    setTestOut(null);
    setDirty(false);
  }, [open]);

  // Adopt the server's view of prefs — but never on top of unsaved edits.
  //
  // App polls /api/providers every 20s to notice when the server has been
  // restarted out from under an open tab. That poll calls setInfo, which
  // landed here and reset every field in this form: a provider chosen or a
  // model id typed more than 20 seconds ago was silently reverted to the
  // server's values while the user was still looking at it, and closing the
  // modal then "saved" nothing. Only take the server's copy when there is
  // nothing pending to lose.
  useEffect(() => {
    if (info && !dirty) setPrefsLocal(info.prefs);
  }, [info, dirty]);

  if (!open || !prefs) {
    return open ? (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="muted">loading providers…</div>
        </div>
      </div>
    ) : null;
  }

  // Every edit path goes through one of these two, so nothing can change
  // without the form knowing it is dirty. A stale "saved" left sitting under
  // the save button is the whole reason this state exists.
  const update = (id: CloudProvider, value: string) => {
    setKeysLocal((k) => ({ ...k, [id]: value }));
    setDirty(true);
    setMsg(null);
  };

  const editPrefs = (fn: (s: ProviderPrefs) => ProviderPrefs) => {
    setPrefsLocal((s) => (s ? fn(s) : s));
    setDirty(true);
    setMsg(null);
  };

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
      // Mirror prefs into localStorage alongside the keys. The server holds
      // both in memory only, so without this the provider choice is lost on
      // the next server restart while the key survives — the state that makes
      // a connected cloud provider look connected but never get used.
      if (prefs) savePrefs(prefs);
      const next = await api.setProviders({ keys: wire, prefs: prefs ?? undefined });
      // Clear before onInfo so the effect above is free to adopt the server's
      // echo of what we just pushed.
      setDirty(false);
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
                      editPrefs((s) => ({
                        ...s,
                        models: { ...(s.models ?? {}), [p.id]: e.target.value || undefined },
                      }))
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
                  editPrefs((s) => ({
                    ...s,
                    models: { ...(s.models ?? {}), ollama: e.target.value || undefined },
                  }))
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
                      editPrefs((s) => ({ ...s, [k]: e.target.value as ProviderPrefs[typeof k] }))
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
            {/* The router resolves the tier against the SERVER's settings, so
                a test run with edits still pending reports on the old config
                and reads as though the change did nothing. Disabled until the
                form matches what the server holds. `clear cache` is exempt —
                it takes no provider settings and is unaffected by them. */}
            {dirty && (
              <div className="small status-warn">
                save first — a test routes on the server's saved settings, not the edits above.
              </div>
            )}
            <div className="test-row">
              <button
                className="ghost-btn"
                onClick={() => testRoute('society')}
                disabled={busy || dirty}
                title={dirty ? 'save your changes first — this tests the saved settings' : undefined}
              >
                test society (ollama)
              </button>
              <button
                className="ghost-btn"
                onClick={() => testRoute('council')}
                disabled={busy || dirty}
                title={dirty ? 'save your changes first — this tests the saved settings' : undefined}
              >
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
          {/* Pending edits outrank any earlier message. "saved" used to sit
              here unchanged while the form was edited underneath it, so the
              footer read as saved when nothing had been pushed — next to a
              save button, that is the one thing it must never say wrongly. */}
          {dirty ? (
            <span className="small status-warn">unsaved changes</span>
          ) : (
            msg && <span className="muted small">{msg}</span>
          )}
          <button className="primary-btn" onClick={save} disabled={busy}>
            {dirty ? 'save changes' : 'save'}
          </button>
        </div>
      </div>
    </div>
  );
}
