// Pause / resume / stop for a running population simulation.
//
// runSimulation asks two things of a control before each agent starts: may
// another agent start (`ready`), and which signal should the agent's LLM
// calls carry (`signal`). Pausing aborts that signal, so the calls in flight
// are cancelled instead of waited on — on local Ollama most of them are
// queued, not generating, so this throws away almost no work — and
// runSimulation re-queues those agents to run on resume. Stopping aborts
// too, releases anything waiting, and makes runSimulation throw
// SimulationStopped: a stopped run has no results to aggregate.

/** What runSimulation needs from a run's controller. */
export interface SimulationControl {
  /** Resolves when another agent may start: at once while running, on
   *  resume while paused, and on stop — check `stopped` after. */
  ready(): Promise<void>;
  /** Aborted by pause and by stop. Read as each agent starts, so the calls
   *  in flight when the run is held are cancelled. */
  readonly signal: AbortSignal;
  readonly stopped: boolean;
}

export type SimulationRunState = 'running' | 'paused' | 'stopped';

/** Thrown by runSimulation when its control stopped the run. */
export class SimulationStopped extends Error {
  constructor() {
    super('simulation stopped');
    this.name = 'SimulationStopped';
  }
}

export class SimulationRunControl implements SimulationControl {
  readonly id: string = crypto.randomUUID();
  private current: SimulationRunState = 'running';
  private calls = new AbortController();
  private waiting: Array<() => void> = [];

  get state(): SimulationRunState {
    return this.current;
  }

  get stopped(): boolean {
    return this.current === 'stopped';
  }

  get signal(): AbortSignal {
    return this.calls.signal;
  }

  ready(): Promise<void> {
    if (this.current !== 'paused') return Promise.resolve();
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Hold the run. False when it isn't running. */
  pause(): boolean {
    if (this.current !== 'running') return false;
    this.current = 'paused';
    this.calls.abort();
    return true;
  }

  /** Release a held run. False when it isn't paused. */
  resume(): boolean {
    if (this.current !== 'paused') return false;
    this.current = 'running';
    // A fresh signal for the resumed calls — the old one stays aborted.
    this.calls = new AbortController();
    this.release();
    return true;
  }

  /** End the run for good. False when it already ended. */
  stop(): boolean {
    if (this.current === 'stopped') return false;
    this.current = 'stopped';
    this.calls.abort();
    this.release();
    return true;
  }

  private release(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }
}
