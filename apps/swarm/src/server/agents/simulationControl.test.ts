import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { router } from '../llm/router';
import { sampleSAPopulation } from './saPopulation';
import { runSimulation, type SimulationProgress } from './simulation';
import { SimulationRunControl, SimulationStopped } from './simulationControl';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ENVELOPE = JSON.stringify({
  behaviour: {
    treatmentUptake: 'accepted',
    isolationDays: 7,
    spendingShift: 'reduced',
    rationale: "I'd take it. The clinic is a taxi ride away but it's free.",
  },
  health: {
    infectionProbability: 0.4,
    severityIfInfected: 'moderate',
    mortalityProbability: 0.02,
    hospitalised: true,
  },
  economic: { workdaysLost: 5, outOfPocketCostZar: 300, insurerClaimZar: 0 },
});

/** Stand-in for the LLM: every call replies after `ms`, unless its signal
 *  aborts first — the way Ollama honours the router's signal. */
function fakeLLM(ms: number) {
  const calls: Array<AbortSignal | undefined> = [];
  const spy = spyOn(router, 'route').mockImplementation((_messages, _tier, opts = {}) => {
    calls.push(opts.signal);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => resolve(ENVELOPE), ms);
      const abort = () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      };
      if (opts.signal?.aborted) abort();
      else opts.signal?.addEventListener('abort', abort, { once: true });
    });
  });
  return { calls, spy };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function simulate(size: number, control?: SimulationRunControl, ms = 20) {
  const llm = fakeLLM(ms);
  restore = () => llm.spy.mockRestore();
  const done: number[] = [];
  const run = runSimulation(sampleSAPopulation({ size, seed: 3 }), {
    scenario: 'A new oral antiviral is free at public clinics. What do you do?',
    referenceBlock: '',
    concurrency: 2,
    seed: 11,
    control,
    onProgress: (e: SimulationProgress) => {
      if (e.type === 'sim_progress') done.push(e.done);
    },
  });
  return { run, llm, done };
}

describe('SimulationRunControl', () => {
  test('moves running → paused → running → stopped, refusing no-op moves', () => {
    const c = new SimulationRunControl();
    expect(c.state).toBe('running');
    expect(c.resume()).toBe(false);
    expect(c.pause()).toBe(true);
    expect(c.pause()).toBe(false);
    expect(c.state).toBe('paused');
    expect(c.resume()).toBe(true);
    expect(c.state).toBe('running');
    expect(c.stop()).toBe(true);
    expect(c.stop()).toBe(false);
    expect(c.pause()).toBe(false);
    expect(c.resume()).toBe(false);
    expect(c.state).toBe('stopped');
  });

  test('a pause aborts the calls in flight; a resume hands out a fresh signal', () => {
    const c = new SimulationRunControl();
    const before = c.signal;
    c.pause();
    expect(before.aborted).toBe(true);
    c.resume();
    expect(c.signal.aborted).toBe(false);
    expect(c.signal).not.toBe(before);
  });

  test('ready() holds while paused and lets go on resume or stop', async () => {
    const c = new SimulationRunControl();
    let passed = false;
    await c.ready();
    c.pause();
    const held = c.ready().then(() => {
      passed = true;
    });
    await sleep(5);
    expect(passed).toBe(false);
    c.resume();
    await held;
    expect(passed).toBe(true);

    c.pause();
    const stopped = c.ready();
    c.stop();
    await stopped;
    expect(c.stopped).toBe(true);
  });
});

describe('runSimulation under control', () => {
  test('without a control every agent runs once, as before', async () => {
    const { run, llm } = simulate(4);
    const { results } = await run;
    expect(results).toHaveLength(4);
    expect(results.every((r) => !r.failure)).toBe(true);
    expect(llm.calls).toHaveLength(4);
  });

  test('a pause starts nothing new; resume finishes every agent with no gaps', async () => {
    const control = new SimulationRunControl();
    const { run, llm, done } = simulate(8, control);
    await sleep(30); // two agents done, two in flight
    expect(control.pause()).toBe(true);
    const callsAtPause = llm.calls.length;
    const doneAtPause = done.at(-1) ?? 0;

    await sleep(80);
    expect(llm.calls).toHaveLength(callsAtPause);
    expect(done.at(-1) ?? 0).toBe(doneAtPause);

    expect(control.resume()).toBe(true);
    const { results } = await run;
    expect(results).toHaveLength(8);
    expect(results.every((r) => r && !r.failure)).toBe(true);
    // The calls the pause cut off were made again, not counted as answers.
    expect(llm.calls.length).toBeGreaterThan(8);
    expect(done.at(-1)).toBe(8);
  });

  test('a stop ends the run with no result and no further calls', async () => {
    const control = new SimulationRunControl();
    const { run, llm } = simulate(8, control);
    await sleep(30);
    control.stop();
    await expect(run).rejects.toBeInstanceOf(SimulationStopped);
    const callsAtStop = llm.calls.length;
    await sleep(50);
    expect(llm.calls).toHaveLength(callsAtStop);
  });

  test('a stop releases a paused run', async () => {
    const control = new SimulationRunControl();
    const { run } = simulate(8, control);
    await sleep(30);
    control.pause();
    await sleep(20);
    control.stop();
    await expect(run).rejects.toBeInstanceOf(SimulationStopped);
  });
});
