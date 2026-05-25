// Domain labeller for the WMTR forecast capability.
//
// The W(M, T, R) Monte Carlo math is domain-agnostic: it projects three
// composable capitals forward under shocks. What changes per actuarial
// family is what M, T, R, and the shock vocabulary actually MEAN to the
// reader. This file is the lookup that turns a generic forecast result
// into a domain-faithful card.
//
// `null` for a family means "no sensible M/T/R mapping" — the Hard Data
// card should hide the "Forecast forward" affordance for that family.

import type { ModelFamily } from "../modelCatalog";

export type DomainLabels = {
  /** One-line "what is this forecast about, in this domain's language". */
  headline: string;
  /** What M (material) represents. */
  M: string;
  /** What T (time / capacity) represents. */
  T: string;
  /** What R (relational / structural) represents. */
  R: string;
  /** Domain-relevant shock taxonomy in lower-case prose. */
  shocks: string[];
  /** Override the catastrophic outcome label ("collapsed" reads wrong for
   *  e.g. a reserve ultimate where "blown the tolerance" is more honest). */
  outcomeLabels?: { grew?: string; stabilized?: string; declined?: string; collapsed?: string };
};

const FALLBACK: DomainLabels = {
  headline: "Forecast under shocks",
  M: "Material capital",
  T: "Time / capacity",
  R: "Relational / structural strength",
  shocks: ["mild", "moderate", "severe"],
};

const BY_FAMILY: Partial<Record<ModelFamily, DomainLabels>> = {
  reserving: {
    headline: "Reserve survival under inflation / SI shocks",
    M: "Material reserve (ultimate − paid-to-date)",
    T: "Remaining development tail",
    R: "ATA-factor stability + claim-handling resilience",
    shocks: ["calendar-year inflation", "social-inflation jolt", "court-precedent shift"],
    outcomeLabels: {
      grew: "released",
      stabilized: "held",
      declined: "strained",
      collapsed: "exceeded tolerance",
    },
  },
  life: {
    headline: "Life book survival under demographic / market shocks",
    M: "Total sum-at-risk (or surplus)",
    T: "Remaining policy term · underwriting bandwidth",
    R: "Broker network + reinsurer trust + retention",
    shocks: ["mortality jump", "lapse wave", "interest-rate cliff"],
  },
  mortality: {
    headline: "Mortality trajectory under cohort shocks",
    M: "Exposure (lives at risk)",
    T: "Projection horizon",
    R: "Cohort selection effect + data-quality stability",
    shocks: ["pandemic", "long-run improvements stall", "selection-effect break"],
  },
  pricing: {
    headline: "Pricing book survival under loss-experience shocks",
    M: "Earned premium volume",
    T: "Renewal / retention horizon",
    R: "Channel diversification + brand-trust durability",
    shocks: ["frequency shock", "severity shock", "anti-selection"],
  },
  climate: {
    headline: "Exposure survival under climate hazards",
    M: "Insured asset value at risk",
    T: "Adaptation lead time",
    R: "Spatial diversification + community resilience",
    shocks: ["acute hazard (storm / flood)", "chronic shift (temperature)", "compound event"],
  },
  capital: {
    headline: "Capital sufficiency under stress",
    M: "Own funds",
    T: "Reporting horizon",
    R: "Risk-mitigation contracts + supervisor trust",
    shocks: ["market shock", "underwriting shock", "operational shock"],
  },
  pensions: {
    headline: "Scheme survival under liability shocks",
    M: "Scheme assets",
    T: "Liability-cashflow horizon",
    R: "Sponsor covenant + member loyalty",
    shocks: ["longevity improvement", "discount-rate move", "covenant downgrade"],
    outcomeLabels: {
      grew: "surplus",
      stabilized: "funded",
      declined: "strained",
      collapsed: "underfunded",
    },
  },
  forecast: {
    headline: "Community survival under shocks (W = M^αM · T^αT · R^αR)",
    M: "Material wealth stock",
    T: "Labour-time allocation",
    R: "Family · religion · spatial cohesion",
    shocks: ["climate (drought / flood)", "economic (downturn)", "social (conflict)"],
  },
  // `general` and any unhandled family fall back below.
};

/**
 * Returns the domain labels for a family, or the generic fallback. Pass
 * `null` if you want to hide the affordance for families with no mapping —
 * the caller can branch on whether the result equals the fallback.
 */
export function domainLabelsFor(family: ModelFamily): DomainLabels {
  return BY_FAMILY[family] ?? FALLBACK;
}

/**
 * Does this family have a *bespoke* (not fallback) domain mapping? The
 * Hard Data result card uses this to decide whether to show the
 * "Forecast forward" affordance — only when the mapping is meaningful.
 */
export function hasForecastDomain(family: ModelFamily): boolean {
  return family in BY_FAMILY;
}
