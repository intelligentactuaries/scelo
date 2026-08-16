// Single source of truth for the society sentiment scale — order and
// colors. Three surfaces used to carry their own copies (SocietyGraph,
// SocietySankey, SocietyInspector) and they drifted: a hardcoded neon
// supportive green that washed out on the light theme, ink-colored
// neutral nodes, and one static palette that ignored the theme entirely.
//
// The scale is diverging: green pole → gray midpoint → red pole, in the
// display order below. Poles reuse the app's consensus/dissent/adversarial
// tokens; the supportive and neutral steps are dedicated ThemeColors
// tokens validated for CVD separation in this adjacency order.

import type { Sentiment } from '../../shared/types';
import type { ThemeColors } from '../../shared/constants';

export const SENTIMENT_ORDER: Sentiment[] = [
  'enthusiastic',
  'supportive',
  'neutral',
  'skeptical',
  'hostile',
];

export function sentimentColors(c: ThemeColors): Record<Sentiment, string> {
  return {
    enthusiastic: c.consensus,
    supportive: c.sentSupportive,
    neutral: c.sentNeutral,
    skeptical: c.dissent,
    hostile: c.adversarial,
  };
}

// Cluster hues — shared by SocietyGraph (hulls, node categories, legend
// chips) and SocietySankey (cluster nodes). Previously duplicated in both
// files behind a "keep these in sync" comment.
const CLUSTER_PALETTE = ['#4a9eff', '#b388ff', '#7fc8ff', '#ffd866', '#a0a0a0', '#5fdfb3'];
// Light-theme overrides: c3 (amber) and c5 (mint) wash out on a light ground,
// so they get darker variants there.
const CLUSTER_PALETTE_LIGHT = ['#4a9eff', '#b388ff', '#7fc8ff', '#c99700', '#a0a0a0', '#1f9e7b'];

export function clusterColor(i: number, dark: boolean): string {
  return (dark ? CLUSTER_PALETTE : CLUSTER_PALETTE_LIGHT)[i % CLUSTER_PALETTE.length];
}
