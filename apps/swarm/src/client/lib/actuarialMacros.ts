// KaTeX macro definitions for International Actuarial Notation.
// Passed to katex.render's `macros` option so the Actuary agents can emit
// semantic LaTeX (e.g. \annimm{n}) instead of fragile improvised markup.
// KaTeX ships \angl (1-arg actuarial enclose) and \angln natively — every
// macro here builds on those.

export const ACTUARIAL_MACROS: Record<string, string> = {
  // ─── interest functions ─────────────────────────────────────────────
  '\\vfac': 'v',                                  // discount factor v = 1/(1+i)
  '\\accum': '(1+i)^{#1}',                        // accumulation over #1 years
  '\\rateforce': '\\delta',                       // force of interest
  '\\ratedisc': 'd',                              // rate of discount

  // ─── annuities-certain ─────────────────────────────────────────────
  '\\annimm': 'a_{\\angl{#1}}',                   // a_{\angl{n}}
  '\\anndue': '\\ddot{a}_{\\angl{#1}}',           // ä_{\angl{n}}
  '\\anncont': '\\bar{a}_{\\angl{#1}}',           // continuous
  '\\accimm': 's_{\\angl{#1}}',                   // accumulated value s
  '\\accdue': '\\ddot{s}_{\\angl{#1}}',

  // ─── life table functions ─────────────────────────────────────────
  '\\force': '\\mu_{#1}',                         // force of mortality, e.g. \force{x+t}
  '\\survl': '\\ell_{#1}',                        // l_x (script-l to avoid clash)
  '\\deaths': 'd_{#1}',
  '\\curtexp': 'e_{#1}',                          // curtate expectation
  '\\complexp': '\\overset{\\circ}{e}_{#1}',      // complete expectation (ring)

  // ─── survival / mortality probabilities ───────────────────────────
  // left-subscript via the {}_{t} idiom
  '\\px': '{}_{#1}p_{#2}',                        // \px{t}{x}     => tp_x
  '\\qx': '{}_{#1}q_{#2}',                        // \qx{t}{x}     => tq_x
  '\\defq': '{}_{#1|#2}q_{#3}',                   // \defq{t}{u}{x} => t|u q_x

  // ─── life annuities ─────────────────────────────────────────────
  '\\lifeann': 'a_{#1}',                          // a_x
  '\\lifeanndue': '\\ddot{a}_{#1}',               // ä_x
  '\\templife': '\\ddot{a}_{#1:\\angl{#2}}',      // ä_{x:\angl{n}}

  // ─── life insurances / assurances ───────────────────────────────
  '\\whole': 'A_{#1}',                                            // A_x
  '\\term': 'A^{\\,1}_{#1:\\angl{#2}}',                            // 1 over x
  '\\pureendow': 'A_{#1:\\overset{\\,1}{\\angl{#2}}}',             // 1 over n
  '\\endow': 'A_{#1:\\angl{#2}}',                                  // endowment

  // ─── premiums & reserves ────────────────────────────────────────
  '\\prem': 'P_{#1}',
  '\\premterm': 'P_{#1:\\angl{#2}}',
  '\\reserve': '{}_{#1}V_{#2}',                   // tV_x

  // ─── commutation functions ──────────────────────────────────────
  // D_x N_x C_x M_x R_x S_x need no macro — write plainly.

  // ─── credibility / risk ────────────────────────────────────────
  '\\cred': 'Z = \\frac{#1}{#1 + #2}',             // \cred{n}{k}
};

// Plain-English meaning + a canonical sample call for every macro in
// ACTUARIAL_MACROS. Used by the "▸ notation key" disclosure at the bottom
// of any Actuary justification panel — only the macros that actually
// appeared in that particular justification are shown.
export const ACTUARIAL_MACRO_DOCS: Record<string, { sample: string; meaning: string }> = {
  vfac:       { sample: '\\vfac',              meaning: 'discount factor v = 1/(1+i)' },
  accum:      { sample: '\\accum{n}',          meaning: 'accumulation factor (1+i)^n over n years' },
  rateforce:  { sample: '\\rateforce',         meaning: 'force of interest δ' },
  ratedisc:   { sample: '\\ratedisc',          meaning: 'rate of discount d' },
  annimm:     { sample: '\\annimm{n}',         meaning: 'present value of an n-year annuity-immediate' },
  anndue:     { sample: '\\anndue{n}',         meaning: 'present value of an n-year annuity-due' },
  anncont:    { sample: '\\anncont{n}',        meaning: 'present value of an n-year continuous annuity' },
  accimm:     { sample: '\\accimm{n}',         meaning: 'accumulated value of an n-year annuity-immediate' },
  accdue:     { sample: '\\accdue{n}',         meaning: 'accumulated value of an n-year annuity-due' },
  force:      { sample: '\\force{x+t}',        meaning: 'force of mortality at age x+t (μ)' },
  survl:      { sample: '\\survl{x}',          meaning: 'number of survivors at age x (ℓ_x)' },
  deaths:     { sample: '\\deaths{x}',         meaning: 'deaths between ages x and x+1' },
  curtexp:    { sample: '\\curtexp{x}',        meaning: 'curtate expectation of life at age x' },
  complexp:   { sample: '\\complexp{x}',       meaning: 'complete expectation of life at age x' },
  px:         { sample: '\\px{t}{x}',          meaning: 't-year survival probability for life (x)' },
  qx:         { sample: '\\qx{t}{x}',          meaning: 't-year mortality probability for life (x)' },
  defq:       { sample: '\\defq{t}{u}{x}',     meaning: 'deferred mortality — survives t years then dies within u, for (x)' },
  lifeann:    { sample: '\\lifeann{x}',        meaning: 'whole-life annuity-immediate for (x)' },
  lifeanndue: { sample: '\\lifeanndue{x}',     meaning: 'whole-life annuity-due for (x)' },
  templife:   { sample: '\\templife{x}{n}',    meaning: 'n-year temporary life annuity-due for (x)' },
  whole:      { sample: '\\whole{x}',          meaning: 'whole-life assurance for (x)' },
  term:       { sample: '\\term{x}{n}',        meaning: 'n-year term assurance for (x)' },
  pureendow:  { sample: '\\pureendow{x}{n}',   meaning: 'n-year pure endowment for (x)' },
  endow:      { sample: '\\endow{x}{n}',       meaning: 'n-year endowment assurance for (x)' },
  prem:       { sample: '\\prem{x}',           meaning: 'net premium for (x)' },
  premterm:   { sample: '\\premterm{x}{n}',    meaning: 'net premium for an n-year term contract on (x)' },
  reserve:    { sample: '\\reserve{t}{x}',     meaning: 'reserve at duration t for (x)' },
  cred:       { sample: '\\cred{n}{k}',        meaning: 'credibility weight Z = n/(n+k)' },
};

// KaTeX commands we recognise as "safe" so the validation guard (Phase C)
// doesn't flag them. Kept here next to the macros so adding/removing macros
// stays in sync with the whitelist.
export const KATEX_BUILTIN_WHITELIST: ReadonlySet<string> = new Set([
  // structural
  'frac', 'sqrt', 'sum', 'prod', 'int', 'oint', 'lim', 'infty',
  'left', 'right', 'big', 'Big', 'bigg', 'Bigg',
  'cdot', 'cdots', 'dots', 'ldots', 'vdots', 'ddots',
  'quad', 'qquad', 'space', 'thinspace', 'enspace',
  // accents & decorations
  'bar', 'overline', 'underline', 'overset', 'underset',
  'ddot', 'dot', 'tilde', 'hat', 'widehat', 'widetilde',
  'mathrm', 'mathbf', 'mathit', 'mathbb', 'mathcal', 'mathfrak', 'text', 'textbf',
  // greek
  'alpha', 'beta', 'gamma', 'Gamma', 'delta', 'Delta', 'epsilon', 'varepsilon',
  'zeta', 'eta', 'theta', 'Theta', 'vartheta', 'iota', 'kappa', 'lambda',
  'Lambda', 'mu', 'nu', 'xi', 'Xi', 'pi', 'Pi', 'varpi', 'rho', 'varrho',
  'sigma', 'Sigma', 'tau', 'upsilon', 'Upsilon', 'phi', 'Phi', 'varphi',
  'chi', 'psi', 'Psi', 'omega', 'Omega', 'ell', 'partial', 'nabla',
  // relations & operators
  'pm', 'mp', 'times', 'div', 'ast', 'star', 'circ', 'bullet',
  'le', 'leq', 'ge', 'geq', 'neq', 'ne', 'approx', 'equiv', 'sim', 'simeq',
  'propto', 'in', 'notin', 'subset', 'supset', 'subseteq', 'supseteq',
  'cap', 'cup', 'setminus', 'forall', 'exists', 'emptyset',
  'to', 'mapsto', 'leftarrow', 'rightarrow', 'leftrightarrow',
  'Rightarrow', 'Leftarrow', 'Leftrightarrow', 'implies', 'iff',
  // misc
  'angl', 'angln', 'angle',
  'log', 'ln', 'exp', 'sin', 'cos', 'tan', 'csc', 'sec', 'cot',
  'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
  'min', 'max', 'sup', 'inf', 'lim', 'limsup', 'liminf',
  'binom', 'choose', 'pmod', 'bmod',
  'colon', 'mid', 'parallel', 'perp', 'cong',
  'Pr', 'Var', 'Cov', 'E',
]);
