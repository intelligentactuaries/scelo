import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = new URL('../../data/swarm.db', import.meta.url).pathname;
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    spec_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    scenario TEXT NOT NULL,
    society_params_json TEXT NOT NULL,
    provider_prefs_json TEXT NOT NULL,
    status TEXT NOT NULL,
    summary_json TEXT,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    round INTEGER,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id);
  CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(run_id, agent_id);

  CREATE TABLE IF NOT EXISTS cache (
    hash TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS canon (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    year INTEGER,
    abstract TEXT,
    url TEXT,
    takeaway TEXT
  );

  CREATE TABLE IF NOT EXISTS justifications (
    run_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    toolkit_version TEXT NOT NULL,
    vote_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, agent_id),
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_justifications_run ON justifications(run_id);
`);

// Defensive in-place migration: older DBs were created before runs had a
// scenario_summary column. Add it if missing — `ADD COLUMN` is cheap and
// idempotent-safe behind the PRAGMA check.
(() => {
  const cols = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'scenario_summary')) {
    db.exec(`ALTER TABLE runs ADD COLUMN scenario_summary TEXT`);
  }
})();

export type DB = typeof db;
