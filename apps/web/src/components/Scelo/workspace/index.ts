// The Workspace layer — public API.
//
// A verbalizable global workspace for actuarial models: extract the small,
// nameable, decision-relevant set of directions a model is poised to report
// along, and validate them by causal intervention (swap, ablate, selectivity).

export * from "./types";
export { fitSurrogate, type Surrogate, type SurrogateOpts } from "./surrogate";
export {
  activeSubspace,
  gradientCovariance,
  inputCovariance,
  participationRatio,
  reductionCurve,
  rebuiltShare,
  sampleX,
  varianceFractionOf,
  projectOnto,
  type ActiveSubspace,
  type ReductionCurve,
} from "./activeSubspace";
export { ablate, meanGradient, retention, selectivityTable, swapConsistency } from "./causal";
export { buhlmannShrink, type CredibilityResult, type Segment } from "./credibility";
export { protectedReadout, type FairnessInput } from "./fairness";
export { fitBottleneck, type BottleneckOpts } from "./bottleneck";
export { nameDirection, prettyCol } from "./names";
export {
  columnRelevance,
  computeWorkspace,
  numericColumns,
  selectDrivers,
  type Readout,
  type WorkspaceOpts,
} from "./engine";
