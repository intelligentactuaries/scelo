import { useEffect, useRef, useState } from 'react';
import type { CanonWork } from '../../shared/types';
import { api } from '../lib/api';

type Props = {
  works: CanonWork[] | null;
  onChange: (works: CanonWork[]) => void;
};

const SAMPLE_JSON = `{
  "works": [
    {
      "title": "Example: Risk-adjusted returns in emerging-market infrastructure",
      "year": 2024,
      "url": "https://doi.org/10.0000/example",
      "abstract": "A study of...",
      "takeaway": "Concentration risk dominates currency risk above 5 years lock-up."
    }
  ]
}`;

const SAMPLE_BIB = `@article{example2024,
  title = {Risk-adjusted returns in emerging-market infrastructure},
  author = {IAAI, P.},
  year = {2024},
  doi = {10.0000/example}
}`;

export function CanonPanel({ works, onChange }: Props) {
  const [draft, setDraft] = useState<CanonWork[]>(works ?? []);
  const [importText, setImportText] = useState('');
  const [importFormat, setImportFormat] = useState<'json' | 'bib'>('json');
  const [importMode, setImportMode] = useState<'replace' | 'append'>('append');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(works ?? []);
  }, [works]);

  function update(i: number, patch: Partial<CanonWork>) {
    setDraft((d) => d.map((w, idx) => (idx === i ? { ...w, ...patch } : w)));
  }
  function remove(i: number) {
    setDraft((d) => d.filter((_, idx) => idx !== i));
  }
  function addBlank() {
    setDraft((d) => [...d, { title: '' }]);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.replaceCanon(draft.filter((w) => w.title.trim()));
      onChange(r.works);
      setMsg(`saved ${r.count} works`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'save failed');
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (!importText.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.importCanon({ format: importFormat, text: importText, mode: importMode });
      onChange(r.works);
      setMsg(`imported ${r.imported} works; canon now has ${r.count}`);
      setImportText('');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'import failed');
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    setImportText(text);
    const lower = f.name.toLowerCase();
    if (lower.endsWith('.bib')) setImportFormat('bib');
    else setImportFormat('json');
    e.target.value = '';
  }

  return (
    <div className="canon-scroll">
      <div className="syn-note muted small">
        agents inject the condensed canon (title + takeaway) into every system prompt under{' '}
        <code>## IAAI Canon — apply where relevant</code>. if empty, agents are told to say so —
        no fabricated citations.
      </div>

      <section className="syn-section">
        <div className="canon-headline">
          <div className="panel-label">canon ({draft.length})</div>
          <div className="canon-actions">
            <button className="ghost-btn" onClick={addBlank} disabled={busy}>
              + add row
            </button>
            <button className="primary-btn" onClick={save} disabled={busy}>
              save
            </button>
          </div>
        </div>

        {draft.length === 0 && (
          <div className="muted small">no works yet. import or add a row below.</div>
        )}

        <div className="canon-list">
          {draft.map((w, i) => (
            <div key={i} className="canon-row">
              <div className="canon-row-head">
                <input
                  className="canon-title"
                  placeholder="title (required)"
                  value={w.title}
                  onChange={(e) => update(i, { title: e.target.value })}
                />
                <input
                  className="canon-year num"
                  placeholder="year"
                  type="number"
                  value={w.year ?? ''}
                  onChange={(e) =>
                    update(i, { year: e.target.value ? Number(e.target.value) : undefined })
                  }
                />
                <button className="ghost-btn" onClick={() => remove(i)} disabled={busy}>
                  remove
                </button>
              </div>
              <input
                className="canon-url"
                placeholder="url (optional)"
                value={w.url ?? ''}
                onChange={(e) => update(i, { url: e.target.value || undefined })}
              />
              <textarea
                className="canon-takeaway"
                placeholder="1-line takeaway (preferred over abstract — what the model should know)"
                rows={2}
                value={w.takeaway ?? ''}
                onChange={(e) => update(i, { takeaway: e.target.value || undefined })}
              />
              <textarea
                className="canon-abstract"
                placeholder="abstract (optional)"
                rows={2}
                value={w.abstract ?? ''}
                onChange={(e) => update(i, { abstract: e.target.value || undefined })}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="syn-section">
        <div className="panel-label">import — paste or upload</div>
        <div className="muted small">
          accepts <code>.json</code> (array or <code>{'{works:[...]}'}</code>) and{' '}
          <code>.bib</code> (BibTeX).
        </div>
        <div className="import-controls">
          <label className="muted small">
            format
            <select value={importFormat} onChange={(e) => setImportFormat(e.target.value as 'json' | 'bib')}>
              <option value="json">json</option>
              <option value="bib">bibtex</option>
            </select>
          </label>
          <label className="muted small">
            mode
            <select value={importMode} onChange={(e) => setImportMode(e.target.value as 'replace' | 'append')}>
              <option value="append">append</option>
              <option value="replace">replace</option>
            </select>
          </label>
          <button className="ghost-btn" onClick={() => fileRef.current?.click()} disabled={busy}>
            upload file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,.bib"
            style={{ display: 'none' }}
            onChange={onFile}
          />
          <button className="ghost-btn" onClick={() => setImportText(importFormat === 'json' ? SAMPLE_JSON : SAMPLE_BIB)} disabled={busy}>
            sample
          </button>
          <button className="primary-btn" onClick={doImport} disabled={busy || !importText.trim()}>
            import
          </button>
        </div>
        <textarea
          className="canon-import-textarea"
          placeholder={importFormat === 'json' ? 'paste JSON here' : 'paste BibTeX here'}
          rows={10}
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
        />
      </section>

      {msg && <div className="muted small">{msg}</div>}
    </div>
  );
}
