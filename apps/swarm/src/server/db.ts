import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths';

const DB_PATH = join(dataDir(), 'swarm.db');
mkdirSync(dataDir(), { recursive: true });

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

  -- Append-only transcript of the council chatbot, one row per TURN (so a
  -- user question and its reply are two rows). Deliberately NOT foreign-keyed
  -- to runs: the audit trail must survive a run being deleted, which is the
  -- whole point of keeping it. Scelo reads this over /api/chat-log and merges
  -- it with its own chat history into one timeline.
  CREATE TABLE IF NOT EXISTS chat_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    role TEXT NOT NULL,          -- 'user' | 'assistant'
    content TEXT NOT NULL,
    provider TEXT,               -- assistant turns only
    model TEXT,                  -- assistant turns only
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_log_created ON chat_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_chat_log_run ON chat_log(run_id);
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

// Member interviews (memberChat.ts) share the chat_log audit table: an
// `agent_id` says which council / society member was being interviewed
// (NULL = the run-level swarm chatbot) and `meta_json` carries the
// machine-read position the member restated at the end of a reply plus the
// server's consistency verdict against their recorded vote / sentiment.
(() => {
  const cols = db.prepare(`PRAGMA table_info(chat_log)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'agent_id')) {
    db.exec(`ALTER TABLE chat_log ADD COLUMN agent_id TEXT`);
  }
  if (!cols.some((c) => c.name === 'meta_json')) {
    db.exec(`ALTER TABLE chat_log ADD COLUMN meta_json TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_log_agent ON chat_log(run_id, agent_id)`);
})();

// Reconcile orphaned runs on startup. A run left 'running'/'pending' when the
// server last stopped can never resume — the in-memory orchestration (and its
// SSE listeners) are gone — so it would otherwise sit "running" forever and any
// poller (e.g. Scelo's council CTA) would hang waiting for a terminal state.
// Mark them failed at boot. (The root cause of a genuinely hung society step is
// separately fixed by the per-request LLM timeout in llm/router.ts.)
(() => {
  const res = db
    .prepare(
      `UPDATE runs SET status = 'failed',
         error = COALESCE(error, 'interrupted: server restarted before the run completed')
       WHERE status IN ('running', 'pending')`,
    )
    .run();
  if (res.changes > 0) {
    console.log(`[db] reconciled ${res.changes} orphaned run(s) to failed on startup`);
  }
})();

export type DB = typeof db;
