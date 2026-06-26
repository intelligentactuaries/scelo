import type { CouncilAgentResult } from '../../shared/types';
import { PROFESSION_PALETTE, type LegalJurisdiction } from '../../shared/constants';
import { JustificationPanel } from './JustificationPanel';

type Props = {
  agent: CouncilAgentResult | null;
  runId: string | null;
  legalJurisdiction: LegalJurisdiction;
  onClose: () => void;
};

const STANCE_CLASS: Record<CouncilAgentResult['finalStance'], string> = {
  support: 'status-ok',
  oppose: 'status-err',
  abstain: 'muted',
};

export function AgentInspector({ agent, runId, legalJurisdiction, onClose }: Props) {
  if (!agent) {
    return (
      <aside className="inspector">
        <div className="inspector-header">
          <div className="panel-label">agent inspector</div>
        </div>
        <div className="inspector-body empty-state">
          <div className="muted small">click a node in the graph to inspect</div>
        </div>
      </aside>
    );
  }

  const { agent: a, rounds, finalStance, finalConfidence, keyRisk } = agent;
  return (
    <aside className="inspector">
      <div className="inspector-header">
        <div>
          <div
            className="agent-tag"
            style={{ borderLeft: `3px solid ${PROFESSION_PALETTE[a.profession]}` }}
          >
            <div className="agent-id">{a.id}</div>
            <div className="muted small">
              {a.profession} · {a.mbti} · {a.gender}
            </div>
          </div>
        </div>
        <button className="ghost-btn" onClick={onClose}>
          close
        </button>
      </div>

      <div className="inspector-vote">
        <div>
          <div className="panel-label">final stance</div>
          <div className={`big-num ${STANCE_CLASS[finalStance]}`}>{finalStance}</div>
        </div>
        <div>
          <div className="panel-label">confidence</div>
          <div className="big-num num">{finalConfidence}</div>
        </div>
        <div>
          <div className="panel-label">key risk</div>
          <div className="small">{keyRisk}</div>
        </div>
      </div>

      <div className="inspector-body">
        {rounds.map((r) => {
          const isFinal = r.round === 3;
          const base = isFinal
            ? stripR3Json(r.content)
            : stripTrailingConfidenceMarker(r.content);
          // Pull a `recommended_intervention: {…}` block out of the prose and
          // render it as a tidy card instead of raw JSON.
          const { intervention, rest } = extractRecommendedIntervention(base);
          return (
            <section key={r.round} className="round-block">
              <div className="round-header">
                <span className="panel-label">round {r.round}</span>
                {r.stance && (
                  <span className={STANCE_CLASS[r.stance]}>{r.stance}</span>
                )}
                <span className="muted small">conf {r.confidence}</span>
              </div>
              {rest && <pre className="round-content">{rest}</pre>}
              {intervention && <RecommendedIntervention interv={intervention} />}
              {isFinal && r.keyRisk && (
                <div className="round-keyrisk">
                  <span className="panel-label">key risk</span>
                  <span className="small">{r.keyRisk}</span>
                </div>
              )}
            </section>
          );
        })}
        {runId && (
          <JustificationPanel
            runId={runId}
            target={{ kind: 'agent', agentId: a.id }}
            legalJurisdiction={legalJurisdiction}
          />
        )}
      </div>
    </aside>
  );
}

// Round 3 content is the agent's raw vote JSON, sometimes with a prose preamble.
// stance/confidence/key_risk are already surfaced in the round header and the
// dedicated key-risk row, so showing the JSON verbatim is just noise. Strip
// fenced or bare JSON blocks; return only whatever prose surrounds them.
function stripR3Json(content: string): string {
  let out = content.trim();
  // Drop code fences first
  out = out.replace(/```(?:json)?\s*[\s\S]*?```/gi, '');
  // Then drop any balanced {...} block that looks like the vote
  // (keeps strings safe — braces inside JSON string literals don't unbalance depth)
  while (true) {
    const start = out.indexOf('{');
    if (start < 0) break;
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let i = start; i < out.length; i++) {
      const ch = out[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (inString) {
        if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) break;
    const block = out.slice(start, end);
    if (/"\s*stance\s*"/i.test(block) || /"\s*confidence\s*"/i.test(block)) {
      out = (out.slice(0, start) + out.slice(end)).trim();
      continue;
    }
    break;
  }
  return out.trim();
}

// Rounds 1 and 2 often end with "CONFIDENCE: 85" — that's already in the header.
// Be tolerant of model misspellings (CONFCIDENCE, CONFEDENCE) and protocol markers
// like "HOLD VIEW: 90" and "CONFINEMENT: 35" that the prompt schema implies.
function stripTrailingConfidenceMarker(content: string): string {
  return content
    .replace(/\n*\s*(?:CONF[A-Z]*|HOLD\s+VIEW)\s*:\s*\d+\s*$/i, '')
    .trim();
}

// ─── recommended_intervention rendering ───────────────────────────────────

interface RecommendedInterv {
  param: string;
  direction: 'increase' | 'decrease' | string;
  magnitude: 'small' | 'large' | string;
  rationale?: string;
}

// Index just past the {…} block that opens at `start`, or -1. Brace-aware of
// string literals so braces inside quotes don't unbalance the depth.
function balancedBraceEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// Tolerant JSON parse for model output — accepts single quotes and trailing
// commas before falling over.
function looseJsonParse(block: string): unknown {
  try {
    return JSON.parse(block);
  } catch {
    try {
      const sane = block
        .replace(/'/g, '"')
        .replace(/,(\s*[}\]])/g, '$1');
      return JSON.parse(sane);
    } catch {
      return null;
    }
  }
}

// Find a `recommended_intervention: {…}` span, parse it, and return the parsed
// object plus the prose with that span removed.
function extractRecommendedIntervention(content: string): {
  intervention: RecommendedInterv | null;
  rest: string;
} {
  const m = content.match(/recommended[_\s]?intervention\s*[:=]?\s*/i);
  if (!m || m.index === undefined) return { intervention: null, rest: content };
  const braceStart = content.indexOf('{', m.index);
  if (braceStart < 0) return { intervention: null, rest: content };
  const end = balancedBraceEnd(content, braceStart);
  if (end < 0) return { intervention: null, rest: content };
  const parsed = looseJsonParse(content.slice(braceStart, end));
  if (!parsed || typeof parsed !== 'object') return { intervention: null, rest: content };
  const o = parsed as Record<string, unknown>;
  if (typeof o.param !== 'string' || !o.param.trim()) {
    return { intervention: null, rest: content };
  }
  const intervention: RecommendedInterv = {
    param: o.param,
    direction: typeof o.direction === 'string' ? o.direction : 'increase',
    magnitude: typeof o.magnitude === 'string' ? o.magnitude : 'small',
    rationale: typeof o.rationale === 'string' ? o.rationale : undefined,
  };
  const rest = (content.slice(0, m.index) + content.slice(end)).trim();
  return { intervention, rest };
}

// Greek-ify the WMTR weight params so `alphaM` reads as α_M etc.
function paramLabel(param: string): string {
  const map: Record<string, string> = {
    alphaM: 'αₘ', // α subscript m
    alphaT: 'αₜ', // α subscript t
    alphaR: 'αᵣ', // α subscript r
    wF: 'w_F',
    wRel: 'w_Rel',
    wS: 'w_S',
  };
  return map[param] ?? param;
}

function RecommendedIntervention({ interv }: { interv: RecommendedInterv }) {
  const up = interv.direction === 'increase';
  return (
    <div className="round-intervention">
      <span className="panel-label">recommended intervention</span>
      <div className="round-intervention-pill">
        <span className={`round-intervention-arrow ${up ? 'is-up' : 'is-down'}`}>
          {up ? '↑' : '↓'}
        </span>
        <span className="round-intervention-param">{paramLabel(interv.param)}</span>
        <span className="round-intervention-mag">{interv.magnitude}</span>
      </div>
      {interv.rationale && <p className="round-intervention-why">{interv.rationale}</p>}
    </div>
  );
}
