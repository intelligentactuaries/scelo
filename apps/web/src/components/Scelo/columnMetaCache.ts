// Shared, memoised column profiling.
//
// summariseDataset is a full O(rows × cols) pass, and at least four
// independent consumers profile the SAME dataset object (the Soft Data
// workstation, the Tools node picker, the macro-canvas node card, and the
// stage chat context). Each used to run its own pass — multi-second
// main-thread freezes at scale, multiplied per mounted pane.
//
// Every transform in the pipeline creates a NEW dataset object, so caching
// on object identity gives automatic invalidation: one profiling pass per
// dataset version, shared by everyone.

import { type ColumnMeta, type Dataset, summariseDataset } from "./SoftDataWorkstation";

const cache = new WeakMap<Dataset, ColumnMeta[]>();

export function getColumnMetas(dataset: Dataset): ColumnMeta[] {
  let metas = cache.get(dataset);
  if (!metas) {
    metas = summariseDataset(dataset);
    cache.set(dataset, metas);
  }
  return metas;
}
