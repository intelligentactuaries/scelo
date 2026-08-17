import type { ReactNode } from 'react';

type Props = {
  active: 'settings' | 'decision' | 'conversation' | null;
  onOpenSettings: () => void;
  onOpenDecision: () => void;
  onOpenConversation: () => void;
  /** Closes any open panel, returning the user to the canvas. */
  onCloseAll: () => void;
  decisionBadge?: number;
};

// Persistent bottom nav for the mobile shell. Three pill buttons drive
// the three overlay panels; the active button doubles as a close action
// so users can dismiss the same way they opened it.
export function MobileNav({
  active,
  onOpenSettings,
  onOpenDecision,
  onOpenConversation,
  onCloseAll,
  decisionBadge,
}: Props) {
  return (
    <nav className="mobile-nav" role="tablist" aria-label="panels">
      <NavBtn
        active={active === 'settings'}
        label="Settings"
        icon={<HamburgerIcon />}
        onClick={() => (active === 'settings' ? onCloseAll() : onOpenSettings())}
      />
      <NavBtn
        active={active === 'decision'}
        label="Decision"
        icon={<DecisionIcon />}
        badge={decisionBadge}
        onClick={() => (active === 'decision' ? onCloseAll() : onOpenDecision())}
      />
      <NavBtn
        active={active === 'conversation'}
        label="Chat"
        icon={<ChatIcon />}
        onClick={() => (active === 'conversation' ? onCloseAll() : onOpenConversation())}
      />
    </nav>
  );
}

function NavBtn({
  active,
  label,
  icon,
  badge,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: ReactNode;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`mobile-nav-btn ${active ? 'is-active' : ''}`}
      onClick={onClick}
    >
      <span className="mobile-nav-icon" aria-hidden="true">
        {icon}
        {badge != null && badge > 0 ? (
          <span className="mobile-nav-badge">{badge > 99 ? '99+' : badge}</span>
        ) : null}
      </span>
      <span className="mobile-nav-label">{label}</span>
    </button>
  );
}

function HamburgerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <line x1="3" y1="5" x2="17" y2="5" />
      <line x1="3" y1="10" x2="17" y2="10" />
      <line x1="3" y1="15" x2="17" y2="15" />
    </svg>
  );
}

function DecisionIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="14" cy="6" r="2.2" />
      <circle cx="10" cy="14" r="2.2" />
      <line x1="6" y1="8" x2="10" y2="12" />
      <line x1="14" y1="8" x2="10" y2="12" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M3 5 H17 V13 H8 L4 17 V13 H3 Z" />
    </svg>
  );
}
