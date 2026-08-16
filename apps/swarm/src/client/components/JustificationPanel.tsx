import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type {
  GroupJustificationResponse,
  Justification,
  JustificationFormula,
  JustificationResponse,
} from '../../shared/types';
import type { LegalJurisdiction, Profession } from '../../shared/constants';
import { ACTUARIAL_MACRO_DOCS } from '../lib/actuarialMacros';
import { MathFormula } from './MathFormula';
import { AppliedLine } from './AppliedLine';

export type JustifyTarget =
  | { kind: 'agent'; agentId: string }
  | { kind: 'group'; profession: Profession };

type Props = {
  runId: string;
  target: JustifyTarget;
  legalJurisdiction: LegalJurisdiction;
};

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: JustificationResponse | GroupJustificationResponse }
  | { kind: 'error'; message: string };

export function JustificationPanel({ runId, target, legalJurisdiction }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const targetKey = target.kind === 'agent' ? target.agentId : target.profession;

  // try to load any cached justification on mount / when target changes
  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: 'idle' });
    const fetcher =
      target.kind === 'agent'
        ? api.getJustification(runId, target.agentId)
        : api.getGroupJustification(runId, target.profession);
    fetcher
      .then((r) => {
        if (cancelled) return;
        if (r) setPhase({ kind: 'ready', data: r });
      })
      .catch(() => {
        /* swallow: idle is fine */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, target.kind, targetKey]);

  const run = useCallback(
    async (fresh: boolean) => {
      setPhase({ kind: 'loading' });
      try {
        const r =
          target.kind === 'agent'
            ? await api.justifyAgent(runId, target.agentId, { legalJurisdiction, fresh })
            : await api.justifyGroup(runId, target.profession, { legalJurisdiction, fresh });
        setPhase({ kind: 'ready', data: r });
      } catch (e) {
        setPhase({ kind: 'error', message: e instanceof Error ? e.message : 'failed' });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runId, target.kind, targetKey, legalJurisdiction],
  );

  const generate = useCallback(() => run(false), [run]);
  const regenerate = useCallback(() => run(true), [run]);

  return (
    <section className="justify-block">
      <div className="justify-header">
        <span className="justify-rule" aria-hidden="true">─── </span>
        <span className="panel-label">justification</span>
        <span className="justify-rule" aria-hidden="true"> ─────────────────────</span>
      </div>

      {phase.kind === 'idle' && (
        <button className="ghost-btn justify-cta" onClick={generate}>
          ▸ show justification
        </button>
      )}

      {phase.kind === 'loading' && (
        <div className="justify-loading muted small">
          <span className="justify-spinner" aria-hidden="true" />
          generating…
        </div>
      )}

      {phase.kind === 'error' && (
        <div className="justify-error">
          <div className="status-warn small">{phase.message}</div>
          <button className="ghost-btn" onClick={generate}>
            retry
          </button>
        </div>
      )}

      {phase.kind === 'ready' && (
        <JustificationView
          data={phase.data.justification}
          isActuary={isActuaryTarget(target)}
          onRegen={regenerate}
        />
      )}
    </section>
  );
}

function isActuaryTarget(target: JustifyTarget): boolean {
  if (target.kind === 'group') return target.profession === 'Actuary';
  return /(^|-)actuary(-|$)/i.test(target.agentId);
}

function JustificationView({
  data,
  isActuary,
  onRegen,
}: {
  data: Justification;
  isActuary: boolean;
  onRegen: () => void;
}) {
  return (
    <div className="justify-view">
      {data.framework && (
        <div className="justify-framework">
          <span className="justify-framework-label">framework</span>
          <span className="justify-framework-value">{data.framework}</span>
        </div>
      )}

      {data.citations.length > 0 && (
        <div className="justify-citations">
          <div className="panel-label">citations</div>
          <table className="justify-table">
            <thead>
              <tr>
                <th>source</th>
                <th>locator</th>
                <th>relevance</th>
              </tr>
            </thead>
            <tbody>
              {data.citations.map((c, i) => (
                <tr key={i}>
                  <td>{c.source}</td>
                  <td className="muted">{c.locator || '—'}</td>
                  <td>{c.relevance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.formulas.length > 0 && (
        <div className="justify-formulas">
          <div className="panel-label">formulas</div>
          <div className="justify-formulas-table">
            {data.formulas.map((f, i) => (
              <div
                key={i}
                className={`justify-formula ${f.renderWarning ? 'is-unverified' : ''}`}
              >
                <div className="justify-formula-head">
                  {f.name && <div className="justify-formula-name muted small">{f.name}</div>}
                  {f.renderWarning && (
                    <span className="justify-formula-warning small" title="formula uses notation the renderer does not recognise; KaTeX may show it in error red">
                      unverified notation
                    </span>
                  )}
                </div>
                <MathFormula latex={f.latex} />
                {f.applied && (
                  <div className="justify-formula-applied muted small">
                    applied: <AppliedLine text={f.applied} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {data.body && (
        <div className="justify-body">
          <div className="panel-label">body</div>
          <p className="justify-body-text">{data.body}</p>
        </div>
      )}

      {isActuary && <NotationKey formulas={data.formulas} />}

      <div className="justify-actions">
        <button className="ghost-btn small" onClick={onRegen}>
          ↻ regenerate
        </button>
      </div>
    </div>
  );
}

function NotationKey({ formulas }: { formulas: JustificationFormula[] }) {
  const usedMacros = useMemo(() => {
    const set = new Set<string>();
    for (const f of formulas) {
      const matches = f.latex.match(/\\[a-zA-Z]+/g) ?? [];
      for (const m of matches) {
        const name = m.slice(1);
        if (Object.prototype.hasOwnProperty.call(ACTUARIAL_MACRO_DOCS, name)) {
          set.add(name);
        }
      }
    }
    return [...set].sort();
  }, [formulas]);

  const [open, setOpen] = useState(false);

  if (usedMacros.length === 0) return null;

  return (
    <div className="notation-key">
      <button
        className="notation-key-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="notation-key-arrow">{open ? '▾' : '▸'}</span> notation key
        <span className="muted small notation-key-count">({usedMacros.length})</span>
      </button>
      {open && (
        <table className="notation-key-table">
          <tbody>
            {usedMacros.map((name) => {
              const doc = ACTUARIAL_MACRO_DOCS[name];
              return (
                <tr key={name}>
                  <td className="notation-key-sym">
                    <MathFormula latex={doc.sample} block={false} />
                  </td>
                  <td className="notation-key-meaning">{doc.meaning}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
