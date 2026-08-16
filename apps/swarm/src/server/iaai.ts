import { db } from './db';
import type { CanonWork } from '../shared/types';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHOLAR_URL = 'https://scholar.google.com/citations?user=LNmZYWgAAAAJ&hl=en';
const STUB_PATH = fileURLToPath(new URL('../../data/iaai-works.json', import.meta.url));

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export async function tryFetchScholar(): Promise<CanonWork[] | null> {
  try {
    const r = await fetch(SCHOLAR_URL, {
      signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
    });
    if (!r.ok) return null;
    const html = await r.text();
    if (/Please show you|gs_captcha|unusual traffic|sorry\/index/i.test(html)) return null;
    return parseScholarHtml(html);
  } catch {
    return null;
  }
}

function parseScholarHtml(html: string): CanonWork[] | null {
  const works: CanonWork[] = [];
  const rowRe = /<tr[^>]*class="[^"]*gsc_a_tr[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
  const titleRe = /<a[^>]*class="[^"]*gsc_a_at[^"]*"[^>]*>([^<]+)<\/a>/;
  const yearRe = /<span[^>]*class="[^"]*gsc_a_h[^"]*"[^>]*>(\d{4})<\/span>/;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html))) {
    const row = m[1];
    const t = titleRe.exec(row);
    const y = yearRe.exec(row);
    if (t) {
      works.push({
        title: decodeEntities(t[1]).trim(),
        year: y ? parseInt(y[1], 10) : undefined,
      });
    }
  }
  return works.length ? works : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

export function loadCanon(): CanonWork[] {
  const rows = db
    .query('SELECT title, year, abstract, url, takeaway FROM canon ORDER BY id ASC')
    .all() as {
    title: string;
    year: number | null;
    abstract: string | null;
    url: string | null;
    takeaway: string | null;
  }[];
  return rows.map((r) => ({
    title: r.title,
    year: r.year ?? undefined,
    abstract: r.abstract ?? undefined,
    url: r.url ?? undefined,
    takeaway: r.takeaway ?? undefined,
  }));
}

export function replaceCanon(works: CanonWork[]): number {
  const ins = db.prepare(
    'INSERT INTO canon (title, year, abstract, url, takeaway) VALUES (?, ?, ?, ?, ?)',
  );
  let n = 0;
  const tx = db.transaction(() => {
    db.exec('DELETE FROM canon');
    for (const w of works) {
      const title = w.title?.trim();
      if (!title) continue;
      ins.run(
        title,
        w.year && Number.isFinite(w.year) ? Math.floor(w.year) : null,
        w.abstract?.trim() || null,
        w.url?.trim() || null,
        w.takeaway?.trim() || null,
      );
      n++;
    }
  });
  tx();
  return n;
}

export function buildCondensedCanon(): string {
  const works = loadCanon();
  if (!works.length) return '';
  return works
    .map((w) => {
      const year = w.year ? ` (${w.year})` : '';
      const take =
        w.takeaway?.trim() ||
        w.abstract?.trim()?.replace(/\s+/g, ' ').slice(0, 160) ||
        '(no takeaway provided)';
      return `- "${w.title}"${year} — ${take}`;
    })
    .join('\n');
}

// Field values are brace-counted, not regexed: real BibTeX titles are full
// of nested case-protection braces ({IFRS 17}, {Bayesian}); a non-greedy
// regex stops at the first `}` and silently truncates the field. Bare
// values (`year = 2024,`) are also accepted.
function parseBibFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const keyRe = /(\w+)\s*=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(body))) {
    const key = m[1].toLowerCase();
    let i = keyRe.lastIndex;
    if (body[i] === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < body.length && depth > 0) {
        if (body[j] === '{') depth++;
        else if (body[j] === '}') depth--;
        j++;
      }
      fields[key] = body.slice(i + 1, j - 1).trim();
      keyRe.lastIndex = j;
    } else if (body[i] === '"') {
      let j = i + 1;
      while (j < body.length && body[j] !== '"') j++;
      fields[key] = body.slice(i + 1, j).trim();
      keyRe.lastIndex = j + 1;
    } else {
      let j = i;
      while (j < body.length && body[j] !== ',' && body[j] !== '\n' && body[j] !== '}') j++;
      fields[key] = body.slice(i, j).trim();
      keyRe.lastIndex = j;
    }
  }
  return fields;
}

export function parseBibTeX(input: string): CanonWork[] {
  const works: CanonWork[] = [];
  const entryStart = /@(\w+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = entryStart.exec(input))) {
    const type = m[1].toLowerCase();
    // Walk to the entry's matching close brace (fields may nest freely).
    let depth = 1;
    let i = entryStart.lastIndex;
    while (i < input.length && depth > 0) {
      if (input[i] === '{') depth++;
      else if (input[i] === '}') depth--;
      i++;
    }
    const inner = input.slice(entryStart.lastIndex, i - 1);
    entryStart.lastIndex = i;
    if (type === 'comment' || type === 'preamble' || type === 'string') continue;
    const comma = inner.indexOf(',');
    if (comma === -1) continue; // no fields, just a cite key
    const fields = parseBibFields(inner.slice(comma + 1));
    if (fields.title) {
      let url: string | undefined;
      if (fields.url) url = fields.url;
      else if (fields.doi) url = `https://doi.org/${fields.doi.replace(/^https?:\/\/doi\.org\//, '')}`;
      works.push({
        title: fields.title.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim(),
        year: fields.year ? parseInt(fields.year, 10) : undefined,
        abstract: fields.abstract || undefined,
        url,
      });
    }
  }
  return works;
}

export function parseJsonUpload(input: string): CanonWork[] {
  const j = JSON.parse(input) as unknown;
  let arr: unknown[] = [];
  if (Array.isArray(j)) arr = j;
  else if (j && typeof j === 'object' && Array.isArray((j as { works?: unknown[] }).works))
    arr = (j as { works: unknown[] }).works;
  else throw new Error('expected an array or {works:[...]}');
  return arr
    .map((raw) => {
      const w = raw as Record<string, unknown>;
      const title = String(w.title ?? '').trim();
      if (!title) return null;
      const year = w.year != null ? Number(w.year) : undefined;
      return {
        title,
        year: year && Number.isFinite(year) ? Math.floor(year) : undefined,
        abstract: w.abstract ? String(w.abstract) : undefined,
        url: w.url ? String(w.url) : undefined,
        takeaway: w.takeaway ? String(w.takeaway) : undefined,
      } as CanonWork;
    })
    .filter((x): x is CanonWork => !!x);
}

export interface CanonInitResult {
  source: 'existing' | 'scholar' | 'stub';
  count: number;
}

export async function initCanon(): Promise<CanonInitResult> {
  const existing = loadCanon();
  if (existing.length > 0) return { source: 'existing', count: existing.length };

  const fetched = await tryFetchScholar();
  if (fetched && fetched.length > 0) {
    const n = replaceCanon(fetched);
    return { source: 'scholar', count: n };
  }

  // write stub file if absent
  try {
    if (!existsSync(STUB_PATH)) {
      writeFileSync(STUB_PATH, JSON.stringify({ works: [] }, null, 2));
    }
  } catch {
    // DB is the source of truth; stub is informational
  }
  return { source: 'stub', count: 0 };
}
