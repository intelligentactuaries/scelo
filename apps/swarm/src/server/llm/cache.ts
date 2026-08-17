import { createHash } from 'node:crypto';
import { db } from '../db';

const get = db.query('SELECT response FROM cache WHERE hash = ?');
const put = db.query(
  'INSERT OR REPLACE INTO cache (hash, provider, model, response, created_at) VALUES (?, ?, ?, ?, ?)',
);
const wipe = db.query('DELETE FROM cache');

export interface CacheKeyParts {
  provider: string;
  model: string;
  messages: { role: string; content: string }[];
  opts?: Record<string, unknown>;
}

export function cacheKey(parts: CacheKeyParts): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function readCache(key: string): string | null {
  const row = get.get(key) as { response: string } | null;
  return row?.response ?? null;
}

export function writeCache(key: string, provider: string, model: string, response: string): void {
  put.run(key, provider, model, response, Date.now());
}

export function clearCache(): number {
  const r = wipe.run();
  return r.changes;
}
