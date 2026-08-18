import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type {
  CanonWork,
  ProvidersInfo,
  Run,
  CouncilAgentResult,
  SocietyParams,
} from '../shared/types';
import {
  api,
  loadJurisdiction,
  saveJurisdiction,
  streamJustifyAll,
  streamRun,
  resyncProvidersIfDrifted,
  syncKeysToServer,
  type StreamEvent,
} from './lib/api';
import type { LegalJurisdiction, Profession } from '../shared/constants';
import { ApiKeyVault } from './components/ApiKeyVault';
import { ConversationPanel } from './components/ConversationPanel';
import { MobileNav } from './components/MobileNav';
import { Greeting } from './components/Greeting';
import { ScenarioCard } from './components/ScenarioCard';
import { useMediaQuery, MOBILE_QUERY } from './lib/useMediaQuery';
import { useTheme } from './lib/theme';
import { DecisionSankey } from './components/DecisionSankey';
import { SocietySankey, absentSentiments } from './components/SocietySankey';
import { SankeySegmentInspector } from './components/SankeySegmentInspector';
import { CenterHeading } from './components/CenterHeading';
import {
  PanelLeftIcon,
  ToolsIcon,
  UsersIcon,
  SlidersIcon,
  GlobeIcon,
  WalletIcon,
  GraduationCapIcon,
  BriefcaseIcon,
  FlagIcon,
  ServerIcon,
} from './components/Icons';
import { SubsetSelector, RunControls, ProviderList } from './components/SidebarControls';
import {
  SocietyParamsPanel,
  SocietyParamsSliders,
  IncomeMixSliders,
  EducationMixSliders,
  EmploymentMixSliders,
  CultureInput,
} from './components/SocietyParams';
import { AccordionSection } from './components/AccordionSection';
import { DeliberationOverlay, useElapsed } from './components/DeliberationOverlay';
import { type TabId } from './components/ViewTabs';
import { PetRail } from './components/PetRail';
import { SurfaceSummaries } from './components/SurfaceSummaries';
import { CouncilGraph } from './components/CouncilGraph';
import { SocietyGraph, type SocietyPin } from './components/SocietyGraph';
import { AgentInspector } from './components/AgentInspector';
import { GroupInspector } from './components/GroupInspector';
import { SocietyInspector } from './components/SocietyInspector';
import { SynthesisView } from './components/SynthesisView';
import { SimulationView, useSimulationState } from './components/SimulationView';
import { CanonPanel, useCanonState } from './components/CanonPanel';
import { HelpOverlay } from './components/HelpOverlay';
import { ResizeHandle } from './components/ResizeHandle';
import { ForecastCanvas } from './components/ForecastCanvas';
import { RunStatus, STALL_SEC } from './components/RunStatus';
import {
  explainCouncilGraph,
  explainCouncilSankey,
  explainSocietyGraph,
  explainSocietySankey,
} from './lib/plotExplainers';

interface RoundProgress {
  round: 1 | 2 | 3;
  done: number;
  total: number;
  elapsedMs?: number;
  finished: boolean;
}

interface SocietyProgress {
  done: number;
  total: number;
  finished: boolean;
  elapsedMs?: number;
}

const DEFAULT_SOCIETY_PARAMS: SocietyParams = {
  ageMean: 38,
  ageSpread: 14,
  incomeMix: { low: 0.35, 'lower-mid': 0.25, mid: 0.2, 'upper-mid': 0.15, high: 0.05 },
  educationMix: { primary: 0.2, secondary: 0.5, tertiary: 0.25, postgrad: 0.05 },
  urbanRatio: 0.66,
  riskTolerance: 0.45,
  culture: 'South Africa',
  employmentMix: {
    employed: 0.45,
    'self-employed': 0.12,
    informal: 0.18,
    unemployed: 0.15,
    student: 0.06,
    retired: 0.04,
    child: 0, // society runs sample ages 16-85; key exists for the total Record type
  },
  financialLiteracy: 0.4,
};

export function App() {
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const theme = useTheme();
  const [health, setHealth] = useState<string>('checking...');
  const [info, setInfo] = useState<ProvidersInfo | null>(null);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const [tab, setTab] = useState<TabId>('forecast');
  // The pet rail's three states. `selected === null` is the resting overview
  // (one line per surface); selected-but-not-expanded shows that surface's
  // summary; expanded hands the canvas to the original full view.
  //
  // `tab` still drives every existing consumer — the graphs, the sidebar, the
  // cross-tab jumps — so nothing downstream had to learn about the rail.
  const [selected, setSelected] = useState<TabId | null>(null);
  const [expanded, setExpanded] = useState(false);
  const chooseSurface = useCallback(
    (id: TabId) => {
      setSelected((cur) => {
        if (cur !== id) {
          setExpanded(false);
          setTab(id);
          return id;
        }
        // Second click on the same pet opens it; a third folds it back to the
        // summary, so the rail is always a way out as well as a way in.
        setExpanded((e) => !e);
        return cur;
      });
    },
    [],
  );
  // Cross-tab jumps (a readback figure sending you to the council) must land
  // on the full view, not on a summary the user did not ask for.
  const jumpTo = useCallback((id: TabId) => {
    setTab(id);
    setSelected(id);
    setExpanded(true);
  }, []);
  // Simulation-tab state lives at the App level so it survives tab switches
  // (the view can unmount freely without losing scenario / sliders / results).
  const simulation = useSimulationState();
  const [run, setRun] = useState<Run | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  // `?runId=…` — load an existing complete run (eg. for shareable links
  // and for screenshotting the integrated forecast view).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const rid = sp.get('runId');
    if (!rid) return;
    api
      .getRun(rid)
      .then((r) => {
        setRun(r);
        setRunId(r.id);
        setScenario(r.scenario);
      })
      .catch((e) => setRunError(e instanceof Error ? e.message : 'failed to load run'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [progress, setProgress] = useState<RoundProgress[]>([]);
  const [society, setSociety] = useState<SocietyProgress | null>(null);
  // Deliberation overlay: seat hues, the recent-voices feed, and whether the
  // user has tucked it away (the run keeps going either way).
  const [seatIds, setSeatIds] = useState<Map<number, string>>(() => new Map());
  const [recentVoices, setRecentVoices] = useState<Array<{ seq: number; id: string }>>([]);
  const [overlayHidden, setOverlayHidden] = useState(false);
  const voiceSeqRef = useRef(0);
  const [selectedAgentId, setSelectedAgentIdRaw] = useState<string | null>(null);
  const [pinnedProfession, setPinnedProfessionRaw] = useState<Profession | null>(null);
  const [societyPin, setSocietyPinRaw] = useState<SocietyPin | null>(null);
  // Cross-chart hover sync between the force-graph and the Sankey on
  // the same screen — used identically by both the council and society
  // tabs. Either component emits its affected agent IDs; the OTHER
  // component dims its non-matching nodes/links so hover reads as a
  // single attention focus.
  const [crossHighlight, setCrossHighlight] = useState<{
    source: 'graph' | 'sankey' | 'legend' | 'group';
    agentIds: string[];
    key: string;
    locked: boolean;
  } | null>(null);
  // The council and society tabs both reuse this state; clear it when
  // the user switches tabs so stale council ids don't shadow-dim the
  // society Sankey (different agent universe).
  useEffect(() => {
    setCrossHighlight(null);
  }, [tab]);

  // Pop the decision sidebar open when the user click-locks a Sankey
  // segment so the stats + justification block is visible right away.
  useEffect(() => {
    if (crossHighlight?.locked && crossHighlight.source === 'sankey') {
      setDecisionOpen(true);
    }
  }, [crossHighlight]);

  // Whenever a user selects an agent or pins a profession, also pop the
  // decision sidebar open so they actually see the inspector. The Raw
  // setters above are reserved for internal resets where we don't want
  // to disturb the open/closed state (e.g. unmount cleanup).
  const setSelectedAgentId = useCallback(
    (id: string | null) => {
      setSelectedAgentIdRaw(id);
      if (id) {
        if (isMobile) {
          setSidebarOpen(false);
          setConversationOpen(false);
        }
        setDecisionOpen(true);
      }
    },
    [isMobile],
  );
  const setPinnedProfession = useCallback(
    (p: Profession | null) => {
      setPinnedProfessionRaw(p);
      if (p) {
        if (isMobile) {
          setSidebarOpen(false);
          setConversationOpen(false);
        }
        setDecisionOpen(true);
      }
    },
    [isMobile],
  );
  const setSocietyPin = useCallback(
    (p: SocietyPin | null) => {
      setSocietyPinRaw(p);
      if (p) {
        if (isMobile) {
          setSidebarOpen(false);
          setConversationOpen(false);
        }
        setDecisionOpen(true);
      }
    },
    [isMobile],
  );
  const [inspector, setInspector] = useState<CouncilAgentResult | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const scenarioRef = useRef<HTMLTextAreaElement>(null);

  // Stall detection — timestamp of the last stream event while a run is busy.
  // A 2s ticker recomputes staleness so the graph can flag a hung run (a local
  // model that dies mid-run otherwise leaves the canvas silent forever).
  const lastActivityRef = useRef<number>(Date.now());
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!runBusy) return;
    lastActivityRef.current = Date.now();
    setNowTick(Date.now());
    const id = setInterval(() => setNowTick(Date.now()), 2000);
    return () => clearInterval(id);
  }, [runBusy]);
  const stalledSec = runBusy ? Math.max(0, (nowTick - lastActivityRef.current) / 1000) : null;

  const [scenario, setScenario] = useState<string>('');
  // Post-run editing of the scenario text. The composer that created a run is
  // only rendered in the empty state, so this reveals ScenarioCard's refine
  // layout over the results instead of throwing them away to get at the text.
  const [editingScenario, setEditingScenario] = useState<boolean>(false);
  const [subset, setSubset] = useState<number>(32);
  const [fresh, setFresh] = useState<boolean>(false);
  const [justifyAll, setJustifyAll] = useState<boolean>(false);
  const [legalJurisdiction, setLegalJurisdictionState] = useState<LegalJurisdiction>(loadJurisdiction());

  const setLegalJurisdiction = useCallback((j: LegalJurisdiction) => {
    setLegalJurisdictionState(j);
    saveJurisdiction(j);
  }, []);
  const [societyParams, setSocietyParams] = useState<SocietyParams>(DEFAULT_SOCIETY_PARAMS);
  const [societySize, setSocietySize] = useState<number>(200);
  const [canon, setCanon] = useState<CanonWork[] | null>(null);
  // Canon-tab editor state lifted to App so in-progress edits / import text
  // survive tab switches (mirrors the simulation lift).
  const canonState = useCanonState(canon);

  const [justifyAllBusy, setJustifyAllBusy] = useState<boolean>(false);
  const [justifyAllProgress, setJustifyAllProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const justifyEsRef = useRef<EventSource | null>(null);

  // Resizable panels — widths in px, persisted to localStorage.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() =>
    loadPanelWidth('swarm-council:sidebar-width', 320),
  );
  const [inspectorWidth, setInspectorWidth] = useState<number>(() =>
    loadPanelWidth('swarm-council:inspector-width', 380),
  );
  // The council/society graphs portal their header band (title chip +
  // keys) into this slot, which sits ABOVE the graph+Sankey stack. Side by
  // side, the band then spans both plots — the keys decode the Sankey's
  // nodes as much as the graph's — and, at the full canvas width, six
  // cluster chips fit three to a line instead of one. Stacked, the graph
  // is first anyway, so the band lands in the same place it did.
  const [keysHost, setKeysHost] = useState<HTMLDivElement | null>(null);
  // Sidebar-collapsed boolean. Persisted, defaults to open.
  // Desktop no longer has a way to open the accordion sidebar — the rail's
  // section list replaced it. Mobile keeps it, where a flyout beside a 44px
  // rail has nowhere to go.
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    // Always shut on load, and a stored '1' is deliberately NOT honoured:
    // the rail no longer offers a way to close this panel, so anyone who had
    // it open before would come back to a sidebar they could not dismiss.
    return false;
  });
  useEffect(() => {
    try {
      localStorage.setItem('swarm-council:sidebar-open', sidebarOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [sidebarOpen]);

  // Decision sidebar — collapsible panel on the right that hosts the
  // agent/group inspector. Shut by default: the canvas gets the whole
  // width until there is something to inspect, and picking an agent, a
  // profession or a cluster opens it (see setSelectedAgentId & co.). The
  // choice is sticky across reloads. The key carries a suffix because the
  // panel used to default open and was persisted as such — an old '1'
  // would have kept it open for everyone who ever loaded the page.
  const [decisionOpen, setDecisionOpen] = useState<boolean>(() =>
    loadPanelOpen('swarm-council:decision-open.v2', false),
  );
  useEffect(() => {
    try {
      localStorage.setItem('swarm-council:decision-open.v2', decisionOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [decisionOpen]);

  // Conversation panel — second right column. Shut by default, like the
  // decision sidebar; the "ask the swarm" trigger under the plots opens
  // it, and the choice sticks. Same suffix, same reason.
  const [conversationOpen, setConversationOpen] = useState<boolean>(() =>
    loadPanelOpen('swarm-council:conversation-open.v2', false),
  );
  useEffect(() => {
    try {
      localStorage.setItem('swarm-council:conversation-open.v2', conversationOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [conversationOpen]);

  // ─── Mobile: mutex panel behavior ─────────────────────────────────
  // On mobile only one of (sidebar | decision | conversation) is visible
  // at a time. When we enter mobile mode for the first time, close all
  // three so the canvas has the screen. The helpers below open one panel
  // and close the others.
  useEffect(() => {
    if (isMobile) {
      setSidebarOpen(false);
      setDecisionOpen(false);
      setConversationOpen(false);
    }
    // intentionally not depending on the *Open setters; we only react to
    // the mobile-mode entry/exit edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);

  const mobileActivePanel: 'settings' | 'decision' | 'conversation' | null = isMobile
    ? sidebarOpen
      ? 'settings'
      : decisionOpen
        ? 'decision'
        : conversationOpen
          ? 'conversation'
          : null
    : null;

  const openMobileSettings = useCallback(() => {
    setDecisionOpen(false);
    setConversationOpen(false);
    setSidebarOpen(true);
  }, []);
  const openMobileDecision = useCallback(() => {
    setSidebarOpen(false);
    setConversationOpen(false);
    setDecisionOpen(true);
  }, []);
  const openMobileConversation = useCallback(() => {
    setSidebarOpen(false);
    setDecisionOpen(false);
    setConversationOpen(true);
  }, []);
  const closeMobilePanels = useCallback(() => {
    setSidebarOpen(false);
    setDecisionOpen(false);
    setConversationOpen(false);
  }, []);

  const resizeSidebar = useCallback((delta: number) => {
    setSidebarWidth((w) => clamp(w + delta, 240, 560));
  }, []);
  const resizeInspector = useCallback((delta: number) => {
    setInspectorWidth((w) => clamp(w + delta, 280, 640));
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('swarm-council:sidebar-width', String(sidebarWidth));
    } catch {
      /* localStorage may be unavailable */
    }
  }, [sidebarWidth]);
  useEffect(() => {
    try {
      localStorage.setItem('swarm-council:inspector-width', String(inspectorWidth));
    } catch {
      /* noop */
    }
  }, [inspectorWidth]);

  useEffect(() => {
    api
      .health()
      .then((d) => setHealth(d.ok ? 'ok' : 'down'))
      .catch(() => setHealth('unreachable'));
    syncKeysToServer()
      .then(setInfo)
      .catch(() => api.providers().then(setInfo).catch(() => {}));
    api.getCanon().then((c) => setCanon(c.works)).catch(() => setCanon([]));
  }, []);

  // Keys and prefs live in the server's memory, so every restart drops them —
  // including the `bun --watch` reload that fires on any src/server save. An
  // open tab had no way to notice: the run would just quietly fall back to a
  // local model. Poll the server's view and re-push whatever it has lost.
  //
  // The same poll now refreshes the health chip and the canon count. Both
  // were fetched exactly once on mount, so a page opened during a server
  // blip said "api unreachable · canon: 0" forever — long after the server
  // was back and answering this very poll.
  const canonRef = useRef(canon);
  useEffect(() => {
    canonRef.current = canon;
  }, [canon]);
  useEffect(() => {
    const id = setInterval(() => {
      api
        .health()
        .then((d) => setHealth(d.ok ? 'ok' : 'down'))
        .catch(() => setHealth('unreachable'));
      api
        .providers()
        .then(async (current) => {
          const restored = await resyncProvidersIfDrifted(current);
          setInfo(restored ?? current);
          // Server answered — if the canon never loaded (mount raced a down
          // server), backfill it now rather than showing 0 all session.
          if (!canonRef.current || canonRef.current.length === 0) {
            api.getCanon().then((c) => setCanon(c.works)).catch(() => {});
          }
        })
        .catch(() => {
          /* server down — the health chip above just said so */
        });
    }, 20_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!selectedAgentId || !runId || !selectedAgentId.startsWith('c-')) {
      setInspector(null);
      return;
    }
    let cancelled = false;
    api
      .getAgent(runId, selectedAgentId)
      .then((r) => !cancelled && setInspector(r))
      .catch(() => !cancelled && setInspector(null));
    return () => {
      cancelled = true;
    };
  }, [selectedAgentId, runId]);

  const startRun = useCallback(async () => {
    if (runBusy || !scenario.trim()) return;
    esRef.current?.close();
    esRef.current = null;
    justifyEsRef.current?.close();
    justifyEsRef.current = null;
    // Re-run preserves the previous `run` / `runId` / selection so the graphs
    // stay on-screen while the new run streams. The atomic swap happens later
    // inside onStreamEvent('done') via setRun(full). Only progress bars and
    // any prior error reset right away — those refer to the *new* run.
    if (!run) {
      setRunId(null);
      setSelectedAgentId(null);
      setInspector(null);
    }
    setRunError(null);
    setProgress([]);
    setSociety(null);
    setRunBusy(true);
    lastActivityRef.current = Date.now();
    setJustifyAllBusy(false);
    setJustifyAllProgress(null);
    setTab('forecast');
    try {
      const r = await api.startRun({
        scenario: scenario.trim(),
        subset,
        fresh,
        societyParams,
        societySize,
        justifyAll,
        legalJurisdiction,
      });
      setRunId(r.runId);
      const es = streamRun(r.runId, (e) => onStreamEvent(r.runId, e));
      esRef.current = es;
    } catch (e) {
      setRunBusy(false);
      setRunError(e instanceof Error ? e.message : 'failed to start run');
    }
  }, [scenario, subset, fresh, justifyAll, legalJurisdiction, societyParams, societySize, runBusy, run]);

  // Edit: seed the composer from the run currently on screen. startRun keeps
  // the old run rendered while the new one streams, so the results stay up
  // until there is something to replace them with.
  const editScenario = useCallback(() => {
    if (run) setScenario(run.scenario);
    setEditingScenario(true);
    // Focus after the refine bar has mounted.
    requestAnimationFrame(() => scenarioRef.current?.focus());
  }, [run]);

  // New: drop the run entirely so the empty-state composer — with its preset
  // chips — comes back. Streams are closed first; leaving one open would go
  // on writing into a run that is no longer displayed.
  const newScenario = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    justifyEsRef.current?.close();
    justifyEsRef.current = null;
    setEditingScenario(false);
    setScenario('');
    setRun(null);
    setRunId(null);
    setSelectedAgentId(null);
    setInspector(null);
    setPinnedProfession(null);
    setProgress([]);
    setSociety(null);
    setRunError(null);
    setTab('forecast');
    requestAnimationFrame(() => scenarioRef.current?.focus());
  }, []);

  const justifyAllNow = useCallback(async () => {
    if (!runId || justifyAllBusy) return;
    justifyEsRef.current?.close();
    justifyEsRef.current = null;
    setJustifyAllBusy(true);
    setJustifyAllProgress(null);
    try {
      await api.startJustifyAll(runId, { legalJurisdiction });
      const es = streamJustifyAll(runId, (e) => {
        if (e.type === 'justify_start') {
          setJustifyAllProgress({ done: 0, total: e.total });
        } else if (e.type === 'justify_progress') {
          setJustifyAllProgress({ done: e.done, total: e.total });
        } else if (e.type === 'justify_done') {
          setJustifyAllProgress({ done: e.total, total: e.total });
          setJustifyAllBusy(false);
        } else if (e.type === 'error') {
          setRunError(e.message);
          setJustifyAllBusy(false);
        }
      });
      justifyEsRef.current = es;
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'justify-all failed');
      setJustifyAllBusy(false);
    }
  }, [runId, justifyAllBusy, legalJurisdiction]);

  const onStreamEvent = useCallback((id: string, e: StreamEvent) => {
    lastActivityRef.current = Date.now();
    if (e.type === 'round_start') {
      setSeatIds(new Map());
      setProgress((p) => {
        const next = p.filter((r) => r.round !== e.round);
        return [...next, { round: e.round, done: 0, total: e.total, finished: false }].sort(
          (a, b) => a.round - b.round,
        );
      });
    } else if (e.type === 'agent_done') {
      setProgress((p) =>
        p.map((r) => (r.round === e.round ? { ...r, done: e.done, total: e.total } : r)),
      );
      // Seat colour + the scrolling "who just spoke" feed in the overlay.
      // Keyed by the agent's ordinal in the round so a seat keeps its hue.
      if (e.agentId) {
        const idx = e.done - 1;
        setSeatIds((m) => {
          const next = new Map(m);
          next.set(idx, e.agentId);
          return next;
        });
        setRecentVoices((v) => [{ seq: voiceSeqRef.current++, id: e.agentId }, ...v].slice(0, 4));
      }
    } else if (e.type === 'round_done') {
      setProgress((p) =>
        p.map((r) =>
          r.round === e.round ? { ...r, done: r.total, finished: true, elapsedMs: e.elapsedMs } : r,
        ),
      );
    } else if (e.type === 'society_start') {
      setSociety({ done: 0, total: e.total, finished: false });
      // Seats are indexed per phase. Carrying the council's map into the
      // society phase coloured 200 personas with 32 council agents' hues.
      setSeatIds(new Map());
    } else if (e.type === 'society_progress') {
      setSociety((s) => (s ? { ...s, done: e.done, total: e.total } : { done: e.done, total: e.total, finished: false }));
      if (e.agentId) {
        const idx = e.done - 1;
        setSeatIds((m) => {
          const next = new Map(m);
          next.set(idx, e.agentId as string);
          return next;
        });
        setRecentVoices((v) => [{ seq: voiceSeqRef.current++, id: e.agentId as string }, ...v].slice(0, 4));
      }
    } else if (e.type === 'society_done') {
      setSociety((s) => ({ done: e.total, total: e.total, finished: true, elapsedMs: e.elapsedMs, ...(s ?? {}) }));
      api.getRun(id).then(setRun).catch(() => {});
    } else if (e.type === 'justify_start') {
      setJustifyAllBusy(true);
      setJustifyAllProgress({ done: 0, total: e.total });
    } else if (e.type === 'justify_progress') {
      setJustifyAllProgress({ done: e.done, total: e.total });
    } else if (e.type === 'justify_done') {
      setJustifyAllProgress({ done: e.total, total: e.total });
      setJustifyAllBusy(false);
    } else if (e.type === 'done') {
      api
        .getRun(id)
        .then((full) => {
          setRun(full);
          setRunBusy(false);
          setJustifyAllBusy(false);
        })
        .catch((err) => {
          setRunError(err instanceof Error ? err.message : 'failed to load run');
          setRunBusy(false);
        });
    } else if (e.type === 'error') {
      setRunError(e.message);
      setRunBusy(false);
      setJustifyAllBusy(false);
    }
  }, []);

  // ---- global keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      if (!mod) {
        if (e.key === 'Escape') {
          if (helpOpen) {
            setHelpOpen(false);
            e.preventDefault();
          } else if (vaultOpen) {
            setVaultOpen(false);
            e.preventDefault();
          } else if (selectedAgentId) {
            // Mirror the inspector's close button: Esc drops the agent's
            // locked focus along with the panel.
            setCrossHighlight((cur) =>
              cur?.locked && cur.key === `node:${selectedAgentId}` ? null : cur,
            );
            setSelectedAgentId(null);
            e.preventDefault();
          }
        }
        return;
      }
      if (e.key === 'Enter') {
        // The scenario card's input owns its own ⌘↵ handler
        if (target?.closest('.scenario-card')) return;
        e.preventDefault();
        startRun();
      } else if (e.key === ',') {
        e.preventDefault();
        setVaultOpen((o) => !o);
      } else if (e.key === '/') {
        e.preventDefault();
        setHelpOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [startRun, vaultOpen, helpOpen, selectedAgentId]);

  // What the council tier will actually run on — not what happens to be
  // loaded in ollama. These differ whenever a cloud key is configured (or
  // whenever the server has forgotten one), and the old readout could only
  // ever say "ollama", which is what made a dropped Anthropic key invisible.
  const providerTag = (() => {
    if (!info) return 'provider: …';
    const eff = info.effective?.council;
    if (eff) return `${eff.provider}: ${eff.model}`;
    return info.ollamaSelected ? `ollama: ${info.ollamaSelected}` : 'no provider';
  })();

  const headerTitle = useMemo(() => {
    if (run) return summarise(run.scenario, 80);
    if (runBusy) return 'running…';
    return 'no scenario loaded';
  }, [run, runBusy]);

  const noProviders =
    info != null &&
    !info.ollamaSelected &&
    !info.configured.anthropic &&
    !info.configured.openai &&
    !info.configured.gemini &&
    !info.configured.hf &&
    !info.configured.claude_code;

  const agentInspectorVisible = !!selectedAgentId && selectedAgentId.startsWith('c-');
  const groupInspectorVisible = !agentInspectorVisible && !!pinnedProfession && !!run;
  const inspectorVisible = agentInspectorVisible || groupInspectorVisible;

  // ─── Left-rail quick-access list of sidebar sections.
  // The storageKey must match each AccordionSection's `storageKey` so a
  // click writes through to the same localStorage entry the accordion
  // reads on mount. When sidebar collapsed, clicking expands the sidebar
  // AND opens that section in one motion.
  const SIDEBAR_SECTIONS: { storageKey: string; label: string; icon: ReactNode }[] = [
    { storageKey: 'subset', label: 'Subset', icon: <UsersIcon /> },
    { storageKey: 'run-controls', label: 'Run controls', icon: <SlidersIcon /> },
    { storageKey: 'society-params', label: 'Society parameter', icon: <GlobeIcon /> },
    { storageKey: 'income-mix', label: 'Income mix', icon: <WalletIcon /> },
    { storageKey: 'education-mix', label: 'Education mix', icon: <GraduationCapIcon /> },
    { storageKey: 'employment-mix', label: 'Employment mix', icon: <BriefcaseIcon /> },
    { storageKey: 'culture', label: 'Culture', icon: <FlagIcon /> },
    { storageKey: 'providers', label: 'Providers', icon: <ServerIcon /> },
  ];

  // Flyout state — when the sidebar is collapsed, clicking a section icon
  // pops just THAT section out next to the rail at the y-position where
  // its icon sits. The other icons remain visible, and the layout doesn't
  // shift. Toggling the panel button still does its previous full-expand
  // behaviour (preserves whatever state the accordions are in).
  // The eight setup controls fold behind one icon. They were a permanent
  // 44px strip of unlabelled glyphs down the left edge — eight things to
  // decode before reaching anything, on a shell whose whole point is that
  // the surfaces are six animals.
  const [toolsOpen, setToolsOpen] = useState(false);
  const [flyoutKey, setFlyoutKey] = useState<string | null>(null);
  const [flyoutTop, setFlyoutTop] = useState<number>(0);

  const popSectionFromRail = (storageKey: string, e: ReactMouseEvent<HTMLButtonElement>) => {
    if (flyoutKey === storageKey) {
      setFlyoutKey(null);
      return;
    }
    // Anchor the flyout to the clicked icon's top edge.
    //
    // Measured against `.pet-rail-tools`, which is the flyout's positioned
    // ancestor — NOT `.pet-rail`, which is what it used to be when the tools
    // had a column of their own. Measuring against one box and positioning
    // inside another put every panel exactly as far down the screen as the
    // tools block starts, which is why they were landing near the floor.
    const btn = e.currentTarget;
    const hostRect = btn.closest('.pet-rail-tools')?.getBoundingClientRect();
    const r = btn.getBoundingClientRect();
    const top = hostRect ? r.top - hostRect.top : r.top;
    setFlyoutTop(top);
    setFlyoutKey(storageKey);
  };

  // Close the flyout on Esc or click outside the rail/flyout group.
  useEffect(() => {
    if (!flyoutKey) return;
    const onDown = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target?.closest('.rail-flyout') || target?.closest('.pet-rail')) return;
      setFlyoutKey(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setFlyoutKey(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [flyoutKey]);

  // Opening the full sidebar via the toggle should dismiss any open flyout.
  useEffect(() => {
    if (sidebarOpen) setFlyoutKey(null);
  }, [sidebarOpen]);

  // What to render inside the flyout for a given storageKey. Same content
  // each accordion's expanded view uses — kept in one place so changes
  // there don't drift.
  const renderSectionContent = (key: string): ReactNode => {
    switch (key) {
      case 'subset':
        return <SubsetSelector subset={subset} onSubsetChange={setSubset} />;
      case 'run-controls':
        return (
          <RunControls
            fresh={fresh}
            onFreshChange={setFresh}
            justifyAll={justifyAll}
            onJustifyAllChange={setJustifyAll}
            subset={subset}
            canJustifyAll={
              !!run && run.status === 'complete' && run.councilResults.length > 0
            }
            justifyAllBusy={justifyAllBusy}
            justifyAllProgress={justifyAllProgress}
            onJustifyAll={justifyAllNow}
          />
        );
      case 'society-params':
        return (
          <SocietyParamsSliders
            value={societyParams}
            onChange={setSocietyParams}
            societySize={societySize}
            onSizeChange={setSocietySize}
          />
        );
      case 'income-mix':
        return <IncomeMixSliders value={societyParams} onChange={setSocietyParams} />;
      case 'education-mix':
        return <EducationMixSliders value={societyParams} onChange={setSocietyParams} />;
      case 'employment-mix':
        return <EmploymentMixSliders value={societyParams} onChange={setSocietyParams} />;
      case 'culture':
        return (
          <>
            <CultureInput value={societyParams} onChange={setSocietyParams} />
            <div className="muted small">
              mixes auto-normalise on the server — values are relative weights.
            </div>
          </>
        );
      case 'providers':
        return <ProviderList info={info} />;
      default:
        return null;
    }
  };

  const flyoutSection = flyoutKey
    ? SIDEBAR_SECTIONS.find((s) => s.storageKey === flyoutKey)
    : null;

  // No run, and on a surface that has nothing to show without one. Canon and
  // Simulation are excluded because both work standalone.
  //
  // Council and Society are ALSO excluded while a first run is streaming:
  // the empty stage used to swallow every tab until `run` landed, so a user
  // who pressed "Forecast & convene", hid the overlay and opened Council
  // Reactions got the composer again — nothing anywhere said the council
  // was mid-deliberation. Those two surfaces now fall through to their
  // stacks, whose RunStatus cards narrate the live run. Forecast keeps the
  // composer while busy — its artifact genuinely doesn't exist client-side
  // until the run lands, and the composer's "running…" caption covers it.
  const emptyStage =
    !run &&
    !(runBusy && (tab === 'council' || tab === 'society')) &&
    tab !== 'canon' &&
    tab !== 'simulation';

  // Panel toggle + the setup group, rendered inside the one rail rather than
  // in a 44px column of their own. Two rails down the left edge — six animals
  // in one, eight glyphs in the other — was the same duplication the resting
  // pet rail was removed for.
  const railTools = (
    <>
      {/* One control with two faces: shut it is the panel glyph, open it is
          Setup at the head of its own list. The big accordion sidebar it used
          to swing out is retired — every one of its sections is a click away
          in this list, so the panel was the same eight controls again in a
          taller form. */}
      {!toolsOpen ? (
        <button
          type="button"
          className="sidebar-toggle rail-icon-btn"
          onClick={() => setToolsOpen(true)}
          aria-label="setup controls"
          aria-expanded={false}
        >
          <PanelLeftIcon />
          <span className="rail-icon-label">Setup</span>
        </button>
      ) : (
        <>
          <button
            type="button"
            className="rail-icon-btn rail-tools-toggle is-active"
            onClick={() => {
              setToolsOpen(false);
              setFlyoutKey(null);
            }}
            aria-label="close setup controls"
            aria-expanded
          >
            <ToolsIcon />
            <span className="rail-icon-label">Setup</span>
          </button>
          {SIDEBAR_SECTIONS.map((sec, i) => (
            <button
              key={sec.storageKey}
              type="button"
              className={`rail-icon-btn rail-tool ${flyoutKey === sec.storageKey ? 'is-active' : ''}`}
              onClick={(e) => popSectionFromRail(sec.storageKey, e)}
              aria-label={sec.label}
              aria-pressed={flyoutKey === sec.storageKey}
              style={{ animationDelay: `${i * 26}ms` }}
            >
              {sec.icon}
              <span className="rail-icon-label">{sec.label}</span>
            </button>
          ))}
        </>
      )}
          {flyoutSection && (
            <div
              className="rail-flyout"
              style={{ top: flyoutTop }}
              role="dialog"
              aria-label={flyoutSection.label}
            >
              <div className="rail-flyout-head">
                <span className="rail-flyout-title">
                  <span className="accordion-icon">{flyoutSection.icon}</span>
                  <span>{flyoutSection.label}</span>
                </span>
                <button
                  className="ghost-btn small"
                  onClick={() => setFlyoutKey(null)}
                  aria-label="close"
                  title="close"
                >
                  ×
                </button>
              </div>
              <div className="rail-flyout-body">
                {renderSectionContent(flyoutSection.storageKey)}
              </div>
            </div>
          )}
    </>
  );

  return (
    <div className={`app-shell ${isMobile ? 'is-mobile' : ''}`}>
      <header className="topbar">
        <div className="wordmark">SWARM COUNCIL</div>
        <div className="status-cluster">
          <span className="muted">api</span>
          <span className={health === 'ok' ? 'status-ok' : 'status-warn'}>{health}</span>
          <span className="muted">·</span>
          <span
            className="muted"
            title={
              info
                ? `council runs on this. ollama loaded: ${info.ollamaSelected ?? 'none'} · cloud keys: ${
                    (['anthropic', 'openai', 'gemini', 'hf'] as const)
                      .filter((p) => info.configured[p])
                      .join(', ') || 'none'
                  } · claude code: ${
                    info.claudeCode.available ? `v${info.claudeCode.version ?? '?'}` : 'not found'
                  } · council preference: ${info.prefs.councilProvider}`
                : 'resolving provider…'
            }
          >
            {providerTag}
          </span>
          <span className="muted">·</span>
          <span className="muted">canon: {canon == null ? '…' : canon.length}</span>
          <button
            className="ghost-btn"
            onClick={theme.cycle}
            title={`theme: ${theme.choice} (resolved: ${theme.resolved}). click to cycle system → light → dark.`}
            aria-label="cycle theme"
          >
            {theme.choice === 'system' ? 'auto' : theme.choice}
          </button>
          <button className="ghost-btn" onClick={() => setHelpOpen(true)} title="keyboard shortcuts (⌘/)">
            ?
          </button>
          <button className="ghost-btn" onClick={() => setVaultOpen(true)} title="settings (⌘,)">
            settings
          </button>
        </div>
      </header>

      <div
        className="body"
        style={{
          // Columns: rail · (sidebar | 0) · (resize | 0) · 1fr centre ·
          //          (decision-panel | handle) · (conversation-panel | handle)
          // The right side now has TWO independent panels — decision
          // inspector and conversation chat — each with its own width,
          // resize handle and collapsed-handle fallback.
          gridTemplateColumns: (() => {
            const sidebar = sidebarOpen ? ` ${sidebarWidth}px 6px` : '';
            const decision = decisionOpen ? `6px ${inspectorWidth}px` : `32px`;
            // The conversation moved out of the grid entirely: it is a
            // bottom dock inside the canvas now, not a third right-hand
            // column. Two chat surfaces — a refine-only composer at the
            // bottom and a chat+refine panel on the right — were the same
            // tool twice.
            // No rail column: the rail lives inside the canvas now.
            return `${sidebar.trim() ? sidebar.trim() : ''} 1fr ${decision}`.trim();
          })(),
        }}
      >

        {(isMobile || sidebarOpen) && (
          <aside
            className={`sidebar ${isMobile && sidebarOpen ? 'is-open-mobile' : ''}`}
          >
            {noProviders && (
              <section className="panel">
                <div className="panel-label status-warn">no provider available</div>
                <div className="muted small">
                  start ollama, add a cloud key, or sign in to Claude Code to run the swarm.
                </div>
                <button className="ghost-btn" onClick={() => setVaultOpen(true)}>
                  open settings ⌘,
                </button>
              </section>
            )}
            <AccordionSection
              title="Subset"
              storageKey="subset"
              defaultOpen={true}
              icon={<UsersIcon />}
              summary={<span className="num">{subset}</span>}
            >
              <SubsetSelector subset={subset} onSubsetChange={setSubset} />
            </AccordionSection>
            <AccordionSection
              title="Run controls"
              storageKey="run-controls"
              defaultOpen={false}
              icon={<SlidersIcon />}
            >
              <RunControls
                fresh={fresh}
                onFreshChange={setFresh}
                justifyAll={justifyAll}
                onJustifyAllChange={setJustifyAll}
                subset={subset}
                canJustifyAll={
                  !!run && run.status === 'complete' && run.councilResults.length > 0
                }
                justifyAllBusy={justifyAllBusy}
                justifyAllProgress={justifyAllProgress}
                onJustifyAll={justifyAllNow}
              />
            </AccordionSection>
            <AccordionSection
              title="Society parameter"
              storageKey="society-params"
              defaultOpen={false}
              icon={<GlobeIcon />}
              summary={<span className="num">{societySize}</span>}
            >
              <SocietyParamsSliders
                value={societyParams}
                onChange={setSocietyParams}
                societySize={societySize}
                onSizeChange={setSocietySize}
              />
            </AccordionSection>
            <AccordionSection
              title="Income mix"
              storageKey="income-mix"
              defaultOpen={false}
              icon={<WalletIcon />}
            >
              <IncomeMixSliders value={societyParams} onChange={setSocietyParams} />
            </AccordionSection>
            <AccordionSection
              title="Education mix"
              storageKey="education-mix"
              defaultOpen={false}
              icon={<GraduationCapIcon />}
            >
              <EducationMixSliders value={societyParams} onChange={setSocietyParams} />
            </AccordionSection>
            <AccordionSection
              title="Employment mix"
              storageKey="employment-mix"
              defaultOpen={false}
              icon={<BriefcaseIcon />}
            >
              <EmploymentMixSliders value={societyParams} onChange={setSocietyParams} />
            </AccordionSection>
            <AccordionSection
              title="Culture"
              storageKey="culture"
              defaultOpen={false}
              icon={<FlagIcon />}
              summary={<span className="muted small">{societyParams.culture || '—'}</span>}
            >
              <CultureInput value={societyParams} onChange={setSocietyParams} />
              <div className="muted small">
                mixes auto-normalise on the server — values are relative weights.
              </div>
            </AccordionSection>
            <AccordionSection
              title="Providers"
              storageKey="providers"
              defaultOpen={false}
              icon={<ServerIcon />}
            >
              <ProviderList info={info} />
            </AccordionSection>
          {(progress.length > 0 || society) && (
            <section className="panel">
              <div className="panel-label">progress</div>
              {progress.map((r) => (
                <div key={r.round} className="prog-row">
                  <span className="small">r{r.round}</span>
                  <div className="prog-track">
                    <div
                      className="prog-fill"
                      style={{ width: `${(r.done / Math.max(1, r.total)) * 100}%` }}
                    />
                  </div>
                  <span className="num small">
                    {r.done}/{r.total}
                  </span>
                  {r.finished && r.elapsedMs && (
                    <span className="muted small">{fmtMs(r.elapsedMs)}</span>
                  )}
                </div>
              ))}
              {society && (
                <div className="prog-row">
                  <span className="small">soc</span>
                  <div className="prog-track">
                    <div
                      className="prog-fill"
                      style={{ width: `${(society.done / Math.max(1, society.total)) * 100}%` }}
                    />
                  </div>
                  <span className="num small">
                    {society.done}/{society.total}
                  </span>
                  {society.finished && society.elapsedMs && (
                    <span className="muted small">{fmtMs(society.elapsedMs)}</span>
                  )}
                </div>
              )}
            </section>
          )}
            {runError && (
              <section className="panel">
                <div className="panel-label status-err">error</div>
                <pre className="test-out status-warn">{runError}</pre>
                <button className="ghost-btn" onClick={() => setRunError(null)}>
                  dismiss
                </button>
              </section>
            )}
            {/* Sticky footer — lets the user apply sidebar adjustments without
                having to scroll back to the scenario card. Uses the current
                scenario in state (whatever's typed, refined, or untouched
                from the last run), plus every sidebar control's live value. */}
            <div className="sidebar-rerun">
              <button
                className="primary-btn pill-btn sidebar-rerun-btn"
                disabled={runBusy || !scenario.trim()}
                onClick={startRun}
                title={
                  scenario.trim()
                    ? run
                      ? 'Re-run the swarm with the current scenario and the settings above'
                      : 'Run the swarm with the current scenario and the settings above'
                    : 'Enter a scenario first'
                }
              >
                {runBusy
                  ? 'Running…'
                  : run
                    ? 'Re-run analysis'
                    : 'Run analysis'}
              </button>
              {run && !runBusy && (
                <div className="muted small sidebar-rerun-hint">
                  applies current sidebar settings to the same scenario
                </div>
              )}
            </div>
          </aside>
        )}

        {!isMobile && sidebarOpen && <ResizeHandle side="right" onResize={resizeSidebar} />}

        <main className="canvas">
          {/* The rail lives beside the content, not in the 44px topbar strip
              — it is a vertical column, and putting it there blew the header
              open and clipped the wordmark behind it.
              
              It is HIDDEN at rest. The resting summary list already names
              every surface next to the same animal, so a rail beside it is
              the same six items twice. The rail is what a surface returns to
              once one is chosen — which is exactly what the flight animation
              shows, the icon landing in a seat that appears as it arrives.
              The empty stage keeps a quiet rail because it has no summary
              list to navigate from. */}
          <PetRail
            selected={selected}
            expanded={expanded}
            onSelect={chooseSurface}
            quiet={emptyStage}
            showPets={emptyStage || selected !== null}
            tools={railTools}
          />
          <div
            className="canvas-stack"
            data-tab={tab}
            data-dock={run ? (conversationOpen ? 'open' : 'shut') : 'none'}
          >
          {/* When a run exists (or we're on Canon), the heading lives at the
              top of the canvas. When empty, the heading is hoisted INTO the
              canvas-empty-stage below so it sits right above the scenario
              card (per slide 1's tight greeting → card spacing). */}
          {(run || tab === 'canon' || tab === 'simulation') && (
            <CenterHeading
              scenario={run ? run.scenario : null}
              scenarioSummary={run?.scenarioSummary ?? null}
              summary={run?.summary ?? null}
              councilResults={run?.councilResults}
              tab={tab}
              busy={runBusy}
              onEditScenario={run ? editScenario : undefined}
              onNewScenario={run ? newScenario : undefined}
            />
          )}
          {/* Refine bar — ScenarioCard's post-run layout, which existed but
              was never rendered. Sits between the heading and the results so
              the text being edited stays next to what it produced. */}
          {run && editingScenario && (
            <div className="scenario-edit-bar">
              <ScenarioCard
                ref={scenarioRef}
                scenario={scenario}
                onScenarioChange={setScenario}
                busy={runBusy}
                onRun={startRun}
                dropped
                onRefine={() => {
                  setEditingScenario(false);
                  // `scenario` already holds the edited text — the textarea
                  // writes it on every keystroke — so startRun reads it
                  // without needing the value threaded back through.
                  void startRun();
                }}
              />
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  setEditingScenario(false);
                  // Discard the edit: put the running scenario back so
                  // reopening does not resume a half-typed change.
                  if (run) setScenario(run.scenario);
                }}
              >
                cancel
              </button>
            </div>
          )}
          <div className="canvas-body">
            {runBusy && (
              <div className="canvas-progress-bar">
                <div
                  className="canvas-progress-fill"
                  style={{ width: `${computeOverallPct(progress, society, !!societySize)}%` }}
                />
              </div>
            )}
            {/* Re-run indicator: only shown when there's an existing run on
                screen AND we're busy producing a new one. Floats over the
                graph so the user sees what's about to be replaced without
                losing the current results. */}
            {runBusy && run && (
              <div className="rerun-badge" role="status" aria-live="polite">
                <span className="rerun-badge-dot" aria-hidden="true" />
                <span className="rerun-badge-label">re-running with new settings…</span>
                {(progress.length > 0 || society) && (
                  <span className="rerun-badge-progress">
                    {progress.map((r) => (
                      <span key={r.round} className="rerun-badge-chip">
                        r{r.round} {r.done}/{r.total}
                      </span>
                    ))}
                    {society && (
                      <span className="rerun-badge-chip">
                        soc {society.done}/{society.total}
                      </span>
                    )}
                  </span>
                )}
              </div>
            )}
            {/* No-run empty state: drop the scenario card into the centre per
                slide 1, regardless of the active tab. Once a run lands, the
                tab content (graph / synthesis / canon) takes over. */}
            {emptyStage ? (
              <div className="canvas-empty-stage">
                <Greeting />
                <ScenarioCard
                  ref={scenarioRef}
                  scenario={scenario}
                  onScenarioChange={setScenario}
                  busy={runBusy}
                  onRun={startRun}
                  dropped={false}
                  onRefine={() => {
                    /* unreachable in empty state */
                  }}
                />
                {runBusy && progress.length > 0 && (
                  <div className="muted small canvas-empty-progress">
                    running… {progress.length} of 3 rounds
                  </div>
                )}
              </div>
            ) : !expanded ? (
              /* The minimal resting surface: the rail plus the summaries it
                 opens. The full views below are unmounted here, which is also
                 why the canvas stays quiet while a run is still landing. */
              <SurfaceSummaries
                selected={selected}
                run={run}
                extras={{
                  canonWorks: canonState.draft.length,
                  simRows: simulation.result?.rows.length,
                  simDone: !!simulation.result,
                  // Lets the no-run lines say "deliberating…" instead of
                  // "has not reported" while a first run is streaming.
                  busy: runBusy,
                }}
                onOpen={() => setExpanded(true)}
                onSelect={chooseSurface}
              />
            ) : (
              <>
                {tab === 'forecast' && run && (runError || (stalledSec != null && stalledSec >= STALL_SEC)) && (
                  <RunStatus
                    phase="council"
                    run={run}
                    busy={runBusy}
                    error={runError}
                    stalledSec={stalledSec}
                    progress={progress}
                    society={society}
                    onRetry={startRun}
                  />
                )}
                {tab === 'forecast' && run && (
                  <ForecastCanvas
                    run={run}
                    onShowCouncil={() => jumpTo('council')}
                    onShowSociety={() => jumpTo('society')}
                    onShowSynthesis={() => jumpTo('synthesis')}
                    onFilterByOutcome={() => {
                      // phase 2: actually filter the council inspector to
                      // agents whose vote diverges from this outcome
                    }}
                    onInterveneStarted={(newRunId, wmtr) => {
                      if (!newRunId) {
                        // Inline re-simulation (recouncil:false): no new run, just
                        // a fresh forecast payload — swap it into the current run
                        // so the canvas re-renders the re-simulated trajectory.
                        if (wmtr) setRun((prev) => (prev ? { ...prev, wmtr } : prev));
                        return;
                      }
                      esRef.current?.close();
                      esRef.current = null;
                      setRunId(newRunId);
                      setRunBusy(true);
                      lastActivityRef.current = Date.now();
                      setRunError(null);
                      setProgress([]);
                      setSociety(null);
                      setSeatIds(new Map());
                      setRecentVoices([]);
                      setOverlayHidden(false);
                      const es = streamRun(newRunId, (e) => onStreamEvent(newRunId, e));
                      esRef.current = es;
                    }}
                  />
                )}
                {/* NOT gated on `run` as a whole: on a FIRST run there is no
                    `run` yet, and the old guard left this tab a blank canvas
                    while the council deliberated — the society tab, gated
                    per-child, showed its live status card the whole time.
                    RunStatus is the piece that must always render. */}
                {tab === 'council' && (
                  <>
                  <div className="graph-keys-slot" ref={setKeysHost} />
                  <div className="council-stack">
                    <div className="council-stack-graph">
                      {run && (
                        <CouncilGraph
                          run={run}
                          keysHost={keysHost}
                          selectedAgentId={selectedAgentId}
                          onSelectAgent={setSelectedAgentId}
                          pinnedProfession={pinnedProfession}
                          onPinnedProfessionChange={setPinnedProfession}
                          crossHighlight={crossHighlight}
                          onCrossHighlight={setCrossHighlight}
                          header={
                            run.councilResults.length > 0 && (
                              <div
                                className="graph-title-chip explained-title"
                                data-tooltip={explainCouncilGraph(run)}
                                tabIndex={0}
                                role="note"
                                aria-label={`council reactions. ${explainCouncilGraph(run)}`}
                              >
                                council reactions · adviser network
                              </div>
                            )
                          }
                        />
                      )}
                      <RunStatus
                        phase="council"
                        run={run}
                        busy={runBusy}
                        error={runError}
                        stalledSec={stalledSec}
                        progress={progress}
                        society={society}
                        onRetry={startRun}
                      />
                    </div>
                    {run && run.councilResults.length > 0 && (
                      <div className="council-stack-sankey">
                        <div
                          className="council-stack-sankey-label explained-title"
                          data-tooltip={explainCouncilSankey(run)}
                          tabIndex={0}
                          role="note"
                          aria-label={`council readback. ${explainCouncilSankey(run)}`}
                        >
                          council readback · profession → trust the forecast? → confidence
                        </div>
                        <DecisionSankey
                          run={run}
                          crossHighlight={crossHighlight}
                          onCrossHighlight={setCrossHighlight}
                        />
                      </div>
                    )}
                  </div>
                  </>
                )}
                {tab === 'society' && (
                  <>
                  <div className="graph-keys-slot" ref={setKeysHost} />
                  <div className="council-stack">
                    <div className="council-stack-graph">
                      {run && run.societyResults.length > 0 && (
                        <SocietyGraph
                          run={run}
                          keysHost={keysHost}
                          pinned={societyPin}
                          onPinnedChange={setSocietyPin}
                          crossHighlight={crossHighlight}
                          onCrossHighlight={setCrossHighlight}
                          header={
                            <div
                              className="graph-title-chip explained-title"
                              data-tooltip={explainSocietyGraph(run)}
                              tabIndex={0}
                              role="note"
                              aria-label={`society pulse. ${explainSocietyGraph(run)}`}
                            >
                              society pulse · citizen reactions
                            </div>
                          }
                        />
                      )}
                      <RunStatus
                        phase="society"
                        run={run}
                        busy={runBusy}
                        error={runError}
                        stalledSec={stalledSec}
                        progress={progress}
                        society={society}
                        societySize={societySize}
                        onRetry={startRun}
                      />
                    </div>
                    {run && run.societyResults.length > 0 && (
                      <div className="council-stack-sankey">
                        <div
                          className="council-stack-sankey-label explained-title"
                          data-tooltip={explainSocietySankey(run)}
                          tabIndex={0}
                          role="note"
                          aria-label={`society reactions. ${explainSocietySankey(run)}`}
                        >
                          society reactions to the forecast · cluster → sentiment → intensity
                          {run && absentSentiments(run).length > 0 && (
                            <span className="muted">
                              {' · no '}
                              {absentSentiments(run).join(' or ')}
                              {' reactions'}
                            </span>
                          )}
                        </div>
                        <SocietySankey
                          run={run}
                          crossHighlight={crossHighlight}
                          onCrossHighlight={setCrossHighlight}
                        />
                      </div>
                    )}
                  </div>
                  </>
                )}
                {tab === 'synthesis' && run && (
                  <SynthesisView run={run} onSelectAgent={setSelectedAgentId} />
                )}
                {/* State lives in App (useSimulationState), so the view can
                    unmount on tab switch without losing scenario / sliders /
                    results — no keep-mounted hack needed. */}
                {tab === 'simulation' && <SimulationView state={simulation} />}
                {tab === 'canon' && <CanonPanel onChange={setCanon} state={canonState} />}
              </>
            )}
            {/* Dropped scenario card removed: chat + refine both live in
                the right-side ConversationPanel now, so the bottom dock
                is gone and the graph + Sankey have the full canvas
                height to themselves. */}
          </div>

          {/* One conversation, docked at the bottom. Shut, it is the composer
              bar; open, it is the full panel rising out of it — chat AND
              refine, which the right-hand panel already had and the composer
              only half of. */}
          {run && (
            <div className={`chat-dock ${conversationOpen ? 'is-open' : ''}`}>
              {conversationOpen ? (
                <ConversationPanel
                  className="is-docked"
                  runId={runId}
                  runReady={!!run && run.status === 'complete'}
                  onCollapse={() => setConversationOpen(false)}
                  scenario={scenario}
                  onScenarioChange={setScenario}
                  busy={runBusy}
                  onRefine={(sc) => {
                    setScenario(sc);
                    setTimeout(() => startRun(), 0);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="chat-dock-trigger"
                  onClick={() => setConversationOpen(true)}
                  aria-expanded={false}
                  title="ask the swarm, or refine the scenario"
                >
                  <span className="chat-dock-caret" aria-hidden>
                    ↑
                  </span>
                  <span className="chat-dock-placeholder">ask the swarm</span>
                </button>
              )}
            </div>
          )}
          </div>
        </main>

        {(isMobile || decisionOpen) && (
          <>
            {!isMobile && <ResizeHandle side="left" onResize={resizeInspector} />}
            <section
              className={`decision-panel ${isMobile && decisionOpen ? 'is-open-mobile' : ''}`}
            >
              <div className="decision-panel-head">
                <span className="decision-panel-title">Decision sidebar</span>
                <button
                  className="sidebar-toggle"
                  onClick={() =>
                    isMobile ? closeMobilePanels() : setDecisionOpen(false)
                  }
                  title="collapse decision sidebar"
                  aria-label="collapse decision sidebar"
                >
                  <PanelLeftIcon />
                </button>
              </div>
              <div className="decision-panel-body">
                {(() => {
                  // Click-locked Sankey selection wins on the council and
                  // society tabs — show its stats + justification block.
                  const sankeyLocked =
                    run && crossHighlight && crossHighlight.locked && crossHighlight.source === 'sankey';
                  if (sankeyLocked && (tab === 'council' || tab === 'society')) {
                    return (
                      <SankeySegmentInspector
                        run={run}
                        highlight={crossHighlight}
                        onClose={() => setCrossHighlight(null)}
                      />
                    );
                  }
                  // Council / Synthesis tabs: agent selection takes priority,
                  // then group pin, then empty.
                  if (tab === 'council' || tab === 'synthesis') {
                    if (agentInspectorVisible) {
                      return (
                        <AgentInspector
                          agent={inspector}
                          runId={runId}
                          legalJurisdiction={legalJurisdiction}
                          onClose={() => {
                            // Dropping the panel also drops THIS agent's
                            // click-locked focus — otherwise the graphs stay
                            // dimmed to a selection that no longer exists
                            // anywhere on screen. Other locks (e.g. a Sankey
                            // segment) are left alone.
                            setCrossHighlight((cur) =>
                              cur?.locked && cur.key === `node:${selectedAgentId}` ? null : cur,
                            );
                            setSelectedAgentId(null);
                          }}
                        />
                      );
                    }
                    if (run && pinnedProfession) {
                      return (
                        <GroupInspector
                          run={run}
                          runId={runId}
                          profession={pinnedProfession}
                          legalJurisdiction={legalJurisdiction}
                          onClose={() => {
                            setCrossHighlight((cur) =>
                              cur?.locked && cur.key === `legend:${pinnedProfession}` ? null : cur,
                            );
                            setPinnedProfession(null);
                          }}
                        />
                      );
                    }
                    return <DecisionEmpty hasRun={!!run} tab={tab} />;
                  }
                  // Society tab: legend pin (cluster or sentiment) drives it.
                  if (tab === 'society') {
                    if (run && societyPin) {
                      return (
                        <SocietyInspector
                          run={run}
                          pin={societyPin}
                          onClose={() => {
                            setCrossHighlight((cur) =>
                              cur?.locked &&
                              cur.key === `legend:${societyPin.kind}:${societyPin.name}`
                                ? null
                                : cur,
                            );
                            setSocietyPin(null);
                          }}
                        />
                      );
                    }
                    return <DecisionEmpty hasRun={!!run} tab="society" />;
                  }
                  // Canon: no selection model — show the canon-flavoured empty.
                  return <DecisionEmpty hasRun={!!run} tab="canon" />;
                })()}
              </div>
            </section>
          </>
        )}
        {!isMobile && !decisionOpen && (
          <button
            type="button"
            className="decision-handle decision-handle-btn"
            aria-label="expand decision sidebar"
            title="expand decision sidebar"
            onClick={() => setDecisionOpen(true)}
          >
            <span className="decision-handle-label">decision sidebar</span>
          </button>
        )}

      </div>

      {isMobile && mobileActivePanel && (
        <div
          className="mobile-backdrop"
          onClick={closeMobilePanels}
          aria-hidden="true"
        />
      )}

      {isMobile && (
        <MobileNav
          active={mobileActivePanel}
          onOpenSettings={openMobileSettings}
          onOpenDecision={openMobileDecision}
          onOpenConversation={openMobileConversation}
          onCloseAll={closeMobilePanels}
        />
      )}

      <ApiKeyVault
        open={vaultOpen}
        onClose={() => setVaultOpen(false)}
        info={info}
        onInfo={setInfo}
        legalJurisdiction={legalJurisdiction}
        onLegalJurisdictionChange={setLegalJurisdiction}
      />
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
      {runBusy && overlayHidden && (
        <button
          type="button"
          className="delib-resume"
          onClick={() => setOverlayHidden(false)}
          title="reopen the deliberation view"
        >
          <span className="delib-resume-dot" aria-hidden />
          run in progress — show
        </button>
      )}
      {runBusy && !overlayHidden && (
        <CouncilRunOverlay
          progress={progress}
          society={society}
          seatIds={seatIds}
          recent={recentVoices}
          onHide={() => setOverlayHidden(true)}
          onCancel={() => {
            esRef.current?.close();
            esRef.current = null;
            setRunBusy(false);
            setOverlayHidden(true);
          }}
        />
      )}
    </div>
  );
}

/** Derives the overlay's shape from the run progress App already tracks.
 *  Kept next to App rather than inside DeliberationOverlay so the overlay
 *  itself stays presentational and the simulation view can reuse it. */
function CouncilRunOverlay({
  progress,
  society,
  seatIds,
  recent,
  onHide,
  onCancel,
}: {
  progress: RoundProgress[];
  society: SocietyProgress | null;
  seatIds: Map<number, string>;
  recent: Array<{ seq: number; id: string }>;
  onHide: () => void;
  onCancel: () => void;
}) {
  const elapsed = useElapsed(true);
  const cur = progress[progress.length - 1];
  const inSociety = society != null && !society.finished;

  // Phase drives every label. "starting" is the window between the run being
  // accepted and the first round_start arriving — real, and often several
  // seconds on a cold local model, so it gets the indeterminate comet rather
  // than a 0/0 count that looks broken.
  const phase = inSociety ? 'society' : cur ? 'council' : 'starting';

  const title =
    phase === 'starting'
      ? 'convening the council'
      : phase === 'society'
        ? 'society pulse'
        : `round ${cur?.round ?? 1} · ${ROUND_LABEL[(cur?.round ?? 1) as 1 | 2 | 3]}`;

  const subtitle =
    phase === 'starting'
      ? 'seating stratified personas…'
      : phase === 'society'
        ? `${society?.done ?? 0} / ${society?.total ?? 0} personas reacted`
        : `${cur?.done ?? 0} / ${cur?.total ?? 0} agents responded`;

  // The bloom counts whichever crowd is currently answering. The society
  // phase has its OWN progress: feeding it the council's total froze it at
  // full the moment the phase flipped — one jump, then nothing, while the
  // subtitle beside it went on counting to 200.
  const bloomTotal = phase === 'society' ? (society?.total ?? 0) : (cur?.total ?? 24);
  const bloomDone =
    phase === 'council' ? (cur?.done ?? 0) : phase === 'society' ? (society?.done ?? 0) : 0;

  return (
    <DeliberationOverlay
      eyebrow={`council${society ? ' + society' : ''}`}
      elapsed={elapsed}
      title={title}
      subtitle={subtitle}
      total={bloomTotal}
      litSeats={bloomDone}
      seatIds={seatIds}
      ticks={3}
      tickCurrent={phase === 'council' ? (cur?.round ?? 1) : phase === 'society' ? 3 : 1}
      outerFrac={society ? (society.total > 0 ? society.done / society.total : 0) : null}
      indeterminate={phase === 'starting'}
      recent={recent}
      onHide={onHide}
      onCancel={onCancel}
    />
  );
}

const ROUND_LABEL: Record<1 | 2 | 3, string> = {
  1: 'independent views',
  2: 'peers respond',
  3: 'votes + interventions',
};

function DecisionEmpty({
  hasRun,
  tab,
}: {
  hasRun: boolean;
  tab: TabId;
}) {
  if (!hasRun) {
    return (
      <div className="decision-empty">
        <div className="panel-label">no selection</div>
        <p className="muted small">
          Run a scenario to populate the decision sidebar — once the swarm
          finishes, every group becomes inspectable here.
        </p>
      </div>
    );
  }
  if (tab === 'society') {
    return (
      <div className="decision-empty">
        <div className="panel-label">no selection</div>
        <p className="muted small">
          Pin a cluster (c0…c5) or a sentiment in the legends above the
          society graph to see that group's aggregated profile.
        </p>
        <ul className="muted small decision-empty-hints">
          <li>Cluster panel: size, sentiment mix, sample members.</li>
          <li>Sentiment panel: count, intensity, education mix, sample reactions.</li>
        </ul>
      </div>
    );
  }
  if (tab === 'canon') {
    return (
      <div className="decision-empty">
        <div className="panel-label">canon</div>
        <p className="muted small">
          The IAAI Canon is the knowledge base every agent reads from.
          Edits here propagate to the next run. The decision sidebar
          activates again when you switch to Council, Society or Synthesis.
        </p>
      </div>
    );
  }
  // council + synthesis
  return (
    <div className="decision-empty">
      <div className="panel-label">no selection</div>
      <p className="muted small">
        Click an agent node in the graph to inspect their reasoning, or pin
        a profession in the legend to see the group's aggregated stance.
      </p>
      <ul className="muted small decision-empty-hints">
        <li>Per-agent panel: stance, key risk, three-round votes, justification.</li>
        <li>Per-group panel: collective stance, members, group justification.</li>
      </ul>
    </div>
  );
}

function EmptyState({
  busy,
  progress,
  noProviders,
  onOpenSettings,
}: {
  busy: boolean;
  progress: RoundProgress[];
  noProviders: boolean;
  onOpenSettings: () => void;
}) {
  if (busy) {
    const r = progress[progress.length - 1];
    return (
      <div className="empty-state">
        <div className="empty-headline">round {r?.round ?? 1} in progress</div>
        <div className="muted small">{r ? `${r.done}/${r.total} agents` : 'preparing…'}</div>
      </div>
    );
  }
  if (noProviders) {
    return (
      <div className="empty-state">
        <div className="empty-headline">no provider available</div>
        <div className="muted small">add a cloud key, sign in to Claude Code, or start ollama to begin.</div>
        <button className="ghost-btn" onClick={onOpenSettings}>
          open settings ⌘,
        </button>
      </div>
    );
  }
  return (
    <div className="empty-state">
      <div className="empty-headline">awaiting first run</div>
      <div className="muted small">enter a scenario, then ⌘↵ to run the swarm.</div>
    </div>
  );
}

function SocietyEmpty({
  busy,
  society,
  societySize,
}: {
  busy: boolean;
  society: SocietyProgress | null;
  societySize: number;
}) {
  if (societySize === 0) {
    return (
      <div className="empty-state">
        <div className="muted small">society size set to 0 — society skipped for this run.</div>
      </div>
    );
  }
  if (busy && !society) {
    return (
      <div className="empty-state">
        <div className="empty-headline">council in progress</div>
        <div className="muted small">society begins once the council finishes</div>
      </div>
    );
  }
  if (society && !society.finished) {
    return (
      <div className="empty-state">
        <div className="empty-headline">society polling</div>
        <div className="muted small">{society.done}/{society.total} agents</div>
      </div>
    );
  }
  return (
    <div className="empty-state">
      <div className="muted small">no society results yet</div>
    </div>
  );
}

function computeOverallPct(
  rounds: RoundProgress[],
  society: SocietyProgress | null,
  hasSociety: boolean,
): number {
  // weight: council rounds 60% (20% each), society 40% — if society is in use
  const councilW = hasSociety ? 60 : 100;
  const societyW = hasSociety ? 40 : 0;
  let councilPct = 0;
  for (const r of [1, 2, 3] as const) {
    const rec = rounds.find((x) => x.round === r);
    const pct = rec ? rec.done / Math.max(1, rec.total) : 0;
    councilPct += pct * (councilW / 3);
  }
  let societyPct = 0;
  if (society && hasSociety) {
    societyPct = (society.done / Math.max(1, society.total)) * societyW;
  }
  return Math.min(100, Math.round(councilPct + societyPct));
}

function summarise(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function loadPanelWidth(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

/** A persisted open/shut flag ('1' / '0'); anything else is the fallback. */
function loadPanelOpen(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === '0') return false;
    if (v === '1') return true;
  } catch {
    /* localStorage may be unavailable */
  }
  return fallback;
}
