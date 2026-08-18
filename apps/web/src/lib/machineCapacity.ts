// machineCapacity.ts — "the only limit is the machine".
//
// Soft Data used to cap combining at three files (active + two staged). That
// was a UI convenience, not a real constraint, so it is gone: stage as many
// files as you like. What remains is the honest limit — the renderer's heap.
// Chromium/Electron expose it (`performance.memory.jsHeapSizeLimit`, the
// same number the process dies at); we estimate what a dataset costs to hold
// and refuse only when the projection would actually run the renderer out
// of memory, saying so in bytes. Where the API is missing (Firefox, tests)
// nothing is refused — the machine itself is then the only judge.
//
// Estimates are deliberately rough and slightly pessimistic: a Row is a JS
// object of boxed cells; strings cost ~2 bytes/char plus header, numbers
// ~8-16 bytes as heap values, plus per-row object overhead. We sample rows
// rather than walk millions of them.

import type { Dataset } from "@scelo/core";

export interface HeapInfo {
  /** Bytes currently used by the renderer's JS heap. */
  used: number;
  /** Bytes the renderer may grow to before Chromium kills it. */
  limit: number;
}

type PerfWithMemory = Performance & {
  memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
};

/** null when the platform doesn't expose heap numbers. */
export function heapInfo(): HeapInfo | null {
  if (typeof performance === "undefined") return null;
  const m = (performance as PerfWithMemory).memory;
  if (!m || !Number.isFinite(m.jsHeapSizeLimit) || m.jsHeapSizeLimit <= 0) return null;
  return { used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit };
}

const ROW_OVERHEAD = 56; // object header + hidden class slack per row
const CELL_OVERHEAD = 16; // property slot + boxed value slack per cell
const SAMPLE_ROWS = 256;

/** Approximate bytes per row, sampled evenly across the dataset. */
export function estimateBytesPerRow(ds: Dataset): number {
  const n = ds.rows.length;
  if (n === 0) return ROW_OVERHEAD + ds.columns.length * CELL_OVERHEAD;
  const step = Math.max(1, Math.floor(n / SAMPLE_ROWS));
  let total = 0;
  let count = 0;
  for (let i = 0; i < n; i += step) {
    const row = ds.rows[i];
    let bytes = ROW_OVERHEAD;
    for (const c of ds.columns) {
      const v = row[c];
      bytes += CELL_OVERHEAD;
      if (typeof v === "string") bytes += 12 + v.length * 2;
      else if (typeof v === "number") bytes += 8;
    }
    total += bytes;
    count += 1;
  }
  return count > 0 ? total / count : ROW_OVERHEAD;
}

/** Approximate bytes a dataset occupies in the heap. */
export function estimateDatasetBytes(ds: Dataset): number {
  return Math.round(estimateBytesPerRow(ds) * ds.rows.length + ds.columns.length * 64);
}

/** Fraction of the heap limit we let data climb to before refusing. The
 *  rest is working room: combine builds a copy, profiling allocates,
 *  undo keeps a snapshot. */
export const HEAP_CEILING = 0.8;

export interface CapacityVerdict {
  ok: boolean;
  /** Present when the platform exposes heap numbers. */
  heap: HeapInfo | null;
  /** Bytes the operation is expected to add. */
  addBytes: number;
  /** used + addBytes (× working-copy factor). */
  projected: number;
  /** Human-readable reason when !ok. */
  message: string | null;
}

/** Would holding another `addBytes` (plus a working copy) fit under the
 *  heap ceiling? Never refuses when heap numbers are unavailable. */
export function capacityCheck(addBytes: number, workingCopies = 2): CapacityVerdict {
  const heap = heapInfo();
  const projected = (heap?.used ?? 0) + addBytes * workingCopies;
  if (!heap) return { ok: true, heap: null, addBytes, projected, message: null };
  const ceiling = heap.limit * HEAP_CEILING;
  if (projected <= ceiling) return { ok: true, heap, addBytes, projected, message: null };
  return {
    ok: false,
    heap,
    addBytes,
    projected,
    message: `Not enough memory on this machine to hold that as well: the renderer may use up to ${fmtBytes(heap.limit)} (${fmtBytes(heap.used)} in use), and this file needs about ${fmtBytes(addBytes)} plus working room. Combine or remove some of the loaded data first, or load a smaller sample of this file.`,
  };
}

/** How many rows of `bytesPerRow` the machine can still hold under the
 *  ceiling — Infinity when heap numbers are unavailable. Used to size a
 *  combined result instead of a fixed row cap. */
export function rowBudget(bytesPerRow: number, workingCopies = 2): number {
  const heap = heapInfo();
  if (!heap) return Number.POSITIVE_INFINITY;
  const room = heap.limit * HEAP_CEILING - heap.used;
  if (room <= 0) return 0;
  return Math.max(0, Math.floor(room / Math.max(1, bytesPerRow) / workingCopies));
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return "∞";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
