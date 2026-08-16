// Single source of truth for council stance display. The stored vote shape
// keeps support/oppose/abstain for backwards compatibility, but this app
// runs forecast interrogations: every user-facing surface renders the
// trust vocabulary (see the deliberation protocol in server/agents/
// personas.ts). Three components used to carry their own STANCE_CLASS
// copies and several still showed the raw stance words.

import type { Stance } from '../../shared/types';
import type { ThemeColors } from '../../shared/constants';

export const STANCE_ORDER: Stance[] = ['support', 'oppose', 'abstain'];

export const STANCE_LABEL: Record<Stance, string> = {
  support: 'trust',
  oppose: 'distrust',
  abstain: 'uncertain',
};

export const STANCE_CLASS: Record<Stance, string> = {
  support: 'status-ok',
  oppose: 'status-err',
  abstain: 'muted',
};

export function stanceColors(c: ThemeColors): Record<Stance, string> {
  return {
    support: c.consensus,
    oppose: c.adversarial,
    abstain: c.muted,
  };
}
