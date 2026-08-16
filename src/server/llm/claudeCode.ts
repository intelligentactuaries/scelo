import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, ProviderCall } from './router';

// Claude Code as a provider.
//
// Unlike the keyed cloud providers this one needs no API key: it shells out
// to the `claude` CLI already installed and signed in on this machine, in
// headless mode (`claude -p`), so a council run rides on the user's Claude
// subscription. The prompt goes in on stdin (no argv-length limits), the
// reply comes back as JSON on stdout. Mirrors the Scelo IDE's own
// `chatClaudeCode` so the two apps behave the same way on the same box.
//
// Things this deliberately does NOT do:
//   - `--bare`: it disables OAuth/keychain auth ("strictly ANTHROPIC_API_KEY"),
//     which is exactly the sign-in this provider exists to reuse.
//   - a cmd.exe fallback for Windows npm shims: the native installer ships a
//     real claude.exe, and an npm shim unwraps to `node cli.js`; a shell
//     fallback would be an untested quoting minefield, so a shim we cannot
//     unwrap is reported as such instead.

const isWin = process.platform === 'win32';

/** Router-visible sentinel for "no --model flag: inherit the CLI's default". */
export const CLAUDE_CODE_DEFAULT_MODEL = 'default';

export const CLAUDE_CODE_MISSING =
  'Claude Code CLI not found. Install it from https://claude.com/claude-code and sign in once (run `claude`), then re-detect in settings. No API key needed — the swarm reuses your Claude Code login.';

export interface ClaudeCodeLaunch {
  bin: string;
  /** Args injected before the CLI's own flags (the unwrapped cli.js path). */
  argPrefix: string[];
}

/** Flags that only newer CLIs accept. Detected from `--help` because an
 *  unknown option is a hard exit, which would fail every call on an older
 *  install for the sake of a nicety. */
export interface ClaudeCodeCaps {
  /** `--no-session-persistence`: without it every call writes a resumable
   *  session under ~/.claude/projects — hundreds per council run. */
  noSessionPersistence: boolean;
  /** `--tools ""`: disables the built-in tool set outright. */
  tools: boolean;
}

export interface ClaudeCodeStatus {
  available: boolean;
  bin: string | null;
  version: string | null;
  /** Why it is unavailable, in words the settings modal can show. */
  reason: string | null;
  launch: ClaudeCodeLaunch | null;
  caps: ClaudeCodeCaps;
}

const NO_CAPS: ClaudeCodeCaps = { noSessionPersistence: false, tools: false };

export const UNAVAILABLE: ClaudeCodeStatus = {
  available: false,
  bin: null,
  version: null,
  reason: CLAUDE_CODE_MISSING,
  launch: null,
  caps: NO_CAPS,
};

// ─── Locating the CLI ─────────────────────────────────────────────────────

/** Where a `claude` binary may live, in preference order. PATH first, then
 *  the well-known install locations: the server is often run as a service
 *  (systemd unit, launchd, Task Scheduler) whose PATH is far shorter than
 *  the user's shell — on the desk that started this, `~/.local/bin` (the
 *  native installer's target) is not on the unit's PATH at all. */
export function candidatePaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const list: (string | null | undefined)[] = [];
  // Explicit override wins. SCELO_CLAUDE_BIN is the IDE's name for the same
  // knob; honouring it too means one setting serves both apps.
  list.push(env.SWARM_CLAUDE_BIN, env.SCELO_CLAUDE_BIN);
  if (isWin) {
    // A real .exe beats a .cmd shim, which beats an extensionless sh script.
    list.push(Bun.which('claude.exe'), Bun.which('claude.cmd'), Bun.which('claude'));
    list.push(join(home, '.local', 'bin', 'claude.exe'));
    if (env.APPDATA) list.push(join(env.APPDATA, 'npm', 'claude.cmd'));
    list.push(join(home, '.bun', 'bin', 'claude.exe'), join(home, '.bun', 'bin', 'claude.cmd'));
  } else {
    list.push(Bun.which('claude'));
    list.push(
      join(home, '.local', 'bin', 'claude'), // native installer
      join(home, '.claude', 'local', 'claude'), // older "local" install
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      join(home, '.bun', 'bin', 'claude'),
      join(home, '.npm-global', 'bin', 'claude'),
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of list) {
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/** Unwrap an npm cmd-shim to the node script it targets. The generated .cmd
 *  holds a quoted `%dp0%`-relative path to the JS entry
 *  (`"%~dp0\node_modules\@anthropic-ai\claude-code\cli.js" %*`). Returns a
 *  direct `node <script>` launch, or null when the shim doesn't match or
 *  node isn't findable. */
export function unwrapCmdShim(shimPath: string, text: string, nodeBin: string | null): ClaudeCodeLaunch | null {
  const m = /"%(?:~dp0|dp0%)\\([^"]+\.[cm]?js)"/i.exec(text);
  if (!m) return null;
  const target = join(shimPath, '..', m[1]);
  if (!existsSync(target) || !nodeBin) return null;
  return { bin: nodeBin, argPrefix: [target] };
}

function launchFor(bin: string): { launch: ClaudeCodeLaunch | null; reason: string | null } {
  if (isWin && /\.(cmd|bat)$/i.test(bin)) {
    let text = '';
    try {
      text = readFileSync(bin, 'utf-8');
    } catch {
      /* unreadable shim — reported below */
    }
    const launch = unwrapCmdShim(bin, text, Bun.which('node'));
    return launch
      ? { launch, reason: null }
      : {
          launch: null,
          reason: `found ${bin}, an npm shim this server cannot launch directly — install the native build (irm https://claude.ai/install.ps1 | iex) or make node available on PATH.`,
        };
  }
  return { launch: { bin, argPrefix: [] }, reason: null };
}

/** Run the CLI with fixed args and return stdout, or null on any failure. */
async function probe(launch: ClaudeCodeLaunch, args: string[], timeoutMs = 15_000): Promise<string | null> {
  try {
    const proc = Bun.spawn({
      cmd: [launch.bin, ...launch.argPrefix, ...args],
      cwd: workDir(),
      env: process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
      windowsHide: true,
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out : null;
  } catch {
    return null;
  }
}

export function parseVersion(out: string | null): string | null {
  return out ? (/(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null) : null;
}

export function capsFromHelp(help: string | null): ClaudeCodeCaps {
  if (!help) return NO_CAPS;
  return {
    noSessionPersistence: /(^|\s)--no-session-persistence\b/m.test(help),
    // `--allowed-tools` / `--disallowed-tools` also end in "-tools"; require
    // whitespace before the dashes so only the bare flag counts.
    tools: /(^|\s)--tools\b/m.test(help),
  };
}

/** Find, version and capability-probe the CLI. Cheap enough to run at boot
 *  and again from the settings modal's re-detect button; the result is what
 *  the router caches. Install is proven here, sign-in is not — an unauthed
 *  CLI surfaces on the first real call (and the test button) as a clear
 *  "not signed in" error rather than a slow probe on every boot. */
export async function detectClaudeCode(): Promise<ClaudeCodeStatus> {
  const bin = candidatePaths().find((p) => existsSync(p)) ?? null;
  if (!bin) return UNAVAILABLE;
  const { launch, reason } = launchFor(bin);
  if (!launch) return { ...UNAVAILABLE, bin, reason };
  const [versionOut, helpOut] = await Promise.all([probe(launch, ['--version']), probe(launch, ['--help'])]);
  if (versionOut === null) {
    return {
      ...UNAVAILABLE,
      bin,
      reason: `found ${bin} but \`claude --version\` failed — the install may be broken; re-run the installer.`,
    };
  }
  return {
    available: true,
    bin,
    version: parseVersion(versionOut),
    reason: null,
    launch,
    caps: capsFromHelp(helpOut),
  };
}

// ─── Calling it ───────────────────────────────────────────────────────────

/** A neutral cwd. The CLI treats its cwd as "the project" — reading that
 *  directory's CLAUDE.md, .claude/settings and hooks into every call. A
 *  council persona wants none of that, and the server's own cwd (a
 *  checkout of this repo, or wherever a service unit started it) is the
 *  wrong project anyway. */
let _workDir: string | null = null;
function workDir(): string {
  if (!_workDir) {
    _workDir = join(tmpdir(), 'swarm-council-claude-code');
    mkdirSync(_workDir, { recursive: true });
  }
  return _workDir;
}

/** The instruction that stands in for the CLI's agentic system prompt.
 *  Format-neutral on purpose: society and simulation prompts demand a JSON
 *  envelope, so "answer in plain text" (the IDE's chat wording) would
 *  corrupt them. */
const GUARD =
  'Reply with the answer only, in exactly the form the instructions above ask for. Do not use tools, read or write files, or run commands — this is a one-shot reply with no follow-up.';

/** Split router messages into the CLI's two channels: `--system-prompt`
 *  and the stdin prompt. A single user turn passes verbatim; a multi-turn
 *  thread (chat) becomes a labelled transcript so the one-shot CLI still
 *  sees the conversation. */
export function flattenForCli(messages: Message[]): { system: string; prompt: string } {
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
    .trim();
  const turns = messages.filter((m) => m.role !== 'system');
  const prompt =
    turns.length === 1 && turns[0].role === 'user'
      ? turns[0].content
      : turns.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
  const system = systemText ? `${systemText}\n\n${GUARD}` : GUARD;
  return { system, prompt };
}

/** Compose argv. `--strict-mcp-config` is not optional: without it the CLI
 *  loads every MCP server the user has configured and folds their tool
 *  schemas into the prompt — measured at 5,222 input tokens for a
 *  six-word question, against 167 with the flag. Thirty times the spend
 *  and the latency, on every one of a council's hundreds of calls. */
export function buildArgs(launch: ClaudeCodeLaunch, caps: ClaudeCodeCaps, system: string, model: string | undefined): string[] {
  const args = [...launch.argPrefix, '-p', '--output-format', 'json', '--strict-mcp-config', '--system-prompt', system];
  if (caps.noSessionPersistence) args.push('--no-session-persistence');
  if (caps.tools) args.push('--tools', '');
  if (model && model !== CLAUDE_CODE_DEFAULT_MODEL) args.push('--model', model);
  return args;
}

const NOT_SIGNED_IN = /not logged in|please run \/login|invalid api key|authentication_error|OAuth token/i;

/** An install that exists but has no login is the one failure a user can
 *  fix in ten seconds, so it gets its own message instead of a raw exit. */
function fail(detail: string, generic: string): never {
  if (NOT_SIGNED_IN.test(detail)) {
    throw new Error(
      'Claude Code is installed but not signed in — run `claude` once in a terminal and log in, then retry.',
    );
  }
  throw new Error(generic);
}

/** Turn the CLI's exit into a reply or a throw. */
export function parseResult(stdout: string, stderr: string, code: number | null): string {
  if (code !== 0) {
    const detail = (stderr || stdout).slice(0, 400).trim();
    fail(detail, `claude code exited ${code ?? 'by signal'}: ${detail || 'no output'}`);
  }
  let data: { is_error?: boolean; result?: string; subtype?: string };
  try {
    data = JSON.parse(stdout);
  } catch {
    // Older CLI without --output-format json — stdout is the reply.
    return stdout.trim();
  }
  if (data.is_error) {
    const detail = (data.result ?? '').slice(0, 400);
    fail(detail, `claude code: ${data.subtype ?? 'error'} — ${detail}`);
  }
  return (data.result ?? '').trim();
}

/** The router-facing call. `temperature` and `maxTokens` have no CLI
 *  equivalent and are ignored — the prompts already bound their own
 *  length ("<=120 words", "JSON envelope only"). */
export async function callClaudeCode(c: ProviderCall, status: ClaudeCodeStatus): Promise<string> {
  if (!status.launch) throw new Error(status.reason ?? CLAUDE_CODE_MISSING);
  const { system, prompt } = flattenForCli(c.messages);
  const args = buildArgs(status.launch, status.caps, system, c.model);
  const proc = Bun.spawn({
    cmd: [status.launch.bin, ...args],
    cwd: workDir(),
    env: process.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    signal: c.signal,
    windowsHide: true,
  });
  // Feed the prompt on stdin. Guarded: if the CLI exits before reading
  // (bad flag, auth failure) the pipe is already closed, and the exit code
  // below carries the real error.
  try {
    proc.stdin.write(prompt);
    proc.stdin.end();
  } catch {
    /* reported via the exit below */
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return parseResult(stdout, stderr, code);
}
