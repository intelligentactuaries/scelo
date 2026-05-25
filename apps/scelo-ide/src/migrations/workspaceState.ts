// Data migration: WorkspaceUIState v0 (no `version` field) → v1.
//
// Unlike one-shot filesystem migrations (see ./extractedDir.ts), this
// is idempotent + runs on every read. The IPC handler in main.ts
// pipes any raw JSON it loaded through this transformer; writes always
// normalise to v1 so a downgraded renderer can't put an older shape
// back on disk.
//
// Pattern for future schema reshapes:
//   * Bump the version literal (e.g. add `version: 2` interface).
//   * Add `migrate_v1_to_v2(state: WorkspaceUIStateV1): WorkspaceUIStateV2`.
//   * Chain in `migrateWorkspaceStateToCurrent`.

export interface WorkspaceUIState {
  version: 1;
  openTabs: string[];
  activeTab: string | null;
  /** Last-active sidebar tab. */
  sidebarTab?:
    | "files"
    | "search"
    | "outline"
    | "git"
    | "problems"
    | "tests"
    | "swarm";
  /** Last sidebar pixel width. Clamped on render. */
  sidebarWidth?: number;
  /** P28: AI side-panel visibility + width. Both optional; defaults
   *  apply for installs predating Phase 28. */
  aiPanelVisible?: boolean;
  aiPanelWidth?: number;
  /** P30 follow-up: terminal hidden by default but session kept alive
   *  in the background when hidden. Toggle via Ctrl-\`. */
  terminalVisible?: boolean;
}

/** Legacy v0 shape — no `version` field. Read-only; we never write
 *  this shape back to disk. */
interface WorkspaceUIStateV0 {
  openTabs?: string[];
  activeTab?: string | null;
  sidebarTab?:
    | "files"
    | "search"
    | "outline"
    | "git"
    | "problems"
    | "tests"
    | "swarm";
  sidebarWidth?: number;
  aiPanelVisible?: boolean;
  aiPanelWidth?: number;
  terminalVisible?: boolean;
}

export function migrateWorkspaceStateToV1(raw: unknown): WorkspaceUIState {
  // Any object missing `version: 1` is treated as v0 and migrated.
  if (
    raw &&
    typeof raw === "object" &&
    "version" in raw &&
    (raw as { version: unknown }).version === 1
  ) {
    return raw as WorkspaceUIState;
  }
  const v0 = (raw ?? {}) as WorkspaceUIStateV0;
  return {
    version: 1,
    openTabs: Array.isArray(v0.openTabs) ? v0.openTabs : [],
    activeTab: typeof v0.activeTab === "string" ? v0.activeTab : null,
    sidebarTab: v0.sidebarTab,
    sidebarWidth: typeof v0.sidebarWidth === "number" ? v0.sidebarWidth : undefined,
    aiPanelVisible:
      typeof v0.aiPanelVisible === "boolean" ? v0.aiPanelVisible : undefined,
    aiPanelWidth:
      typeof v0.aiPanelWidth === "number" ? v0.aiPanelWidth : undefined,
    terminalVisible:
      typeof v0.terminalVisible === "boolean" ? v0.terminalVisible : undefined,
  };
}
