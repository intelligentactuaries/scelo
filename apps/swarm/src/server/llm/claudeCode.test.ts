import { describe, expect, test } from 'bun:test';
import {
  CLAUDE_CODE_DEFAULT_MODEL,
  buildArgs,
  candidatePaths,
  capsFromHelp,
  flattenForCli,
  parseResult,
  parseVersion,
  unwrapCmdShim,
} from './claudeCode';

// The parts that decide what the CLI is asked and how its answer is read —
// exercised without spawning anything. Fixtures are the real outputs of
// Claude Code 2.1.233 as captured on 2026-08-16.

const HELP_2_1 = `
  --strict-mcp-config                   Only use MCP servers from --mcp-config,
  --system-prompt <prompt>              System prompt to use for the session
  --tools <tools...>                    Specify the list of available tools from
  --allowedTools, --allowed-tools <tools...>
  --disallowedTools, --disallowed-tools <tools...>
  --no-session-persistence              Disable session persistence - sessions
`;

const HELP_OLD = `
  --strict-mcp-config                   Only use MCP servers from --mcp-config,
  --system-prompt <prompt>              System prompt to use for the session
  --allowedTools, --allowed-tools <tools...>
`;

const LAUNCH = { bin: '/home/u/.local/bin/claude', argPrefix: [] };

describe('capsFromHelp', () => {
  test('finds the newer flags on a current CLI', () => {
    expect(capsFromHelp(HELP_2_1)).toEqual({ noSessionPersistence: true, tools: true });
  });
  test('an older CLI reports neither — --allowed-tools must not count as --tools', () => {
    expect(capsFromHelp(HELP_OLD)).toEqual({ noSessionPersistence: false, tools: false });
  });
  test('no help at all means no caps', () => {
    expect(capsFromHelp(null)).toEqual({ noSessionPersistence: false, tools: false });
  });
});

describe('parseVersion', () => {
  test('reads the semver out of the banner', () => {
    expect(parseVersion('2.1.233 (Claude Code)\n')).toBe('2.1.233');
  });
  test('null in, null out', () => {
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion('garbage')).toBeNull();
  });
});

describe('buildArgs', () => {
  test('always: -p, json, strict mcp, the system prompt', () => {
    const args = buildArgs(LAUNCH, { noSessionPersistence: false, tools: false }, 'SYS', undefined);
    expect(args).toEqual(['-p', '--output-format', 'json', '--strict-mcp-config', '--system-prompt', 'SYS']);
  });
  test('adds the optional flags only when the CLI has them', () => {
    const args = buildArgs(LAUNCH, { noSessionPersistence: true, tools: true }, 'SYS', undefined);
    expect(args).toContain('--no-session-persistence');
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
  });
  test('the default-model sentinel means no --model flag; anything else is passed', () => {
    const none = buildArgs(LAUNCH, { noSessionPersistence: false, tools: false }, 'S', CLAUDE_CODE_DEFAULT_MODEL);
    expect(none).not.toContain('--model');
    const opus = buildArgs(LAUNCH, { noSessionPersistence: false, tools: false }, 'S', 'opus');
    expect(opus.slice(-2)).toEqual(['--model', 'opus']);
  });
  test('an unwrapped npm shim puts the script first', () => {
    const args = buildArgs(
      { bin: 'node', argPrefix: ['C:\\x\\cli.js'] },
      { noSessionPersistence: false, tools: false },
      'S',
      undefined,
    );
    expect(args[0]).toBe('C:\\x\\cli.js');
    expect(args[1]).toBe('-p');
  });
});

describe('flattenForCli', () => {
  test('one user turn goes through verbatim; system gets the no-tools guard appended', () => {
    const { system, prompt } = flattenForCli([
      { role: 'system', content: 'You are agent 7.' },
      { role: 'user', content: 'Round 1: your view.' },
    ]);
    expect(prompt).toBe('Round 1: your view.');
    expect(system.startsWith('You are agent 7.\n\n')).toBe(true);
    expect(system).toContain('Do not use tools');
    // The guard must stay format-neutral: simulation prompts demand JSON.
    expect(system).not.toContain('plain text');
  });
  test('a thread becomes a labelled transcript', () => {
    const { prompt } = flattenForCli([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
    ]);
    expect(prompt).toBe('User: hi\n\nAssistant: hello\n\nUser: again');
  });
  test('no system message → the guard alone', () => {
    const { system } = flattenForCli([{ role: 'user', content: 'x' }]);
    expect(system.startsWith('Reply with the answer only')).toBe(true);
  });
});

describe('parseResult', () => {
  const OK = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '  hello world\n',
    session_id: 'x',
  });
  test('happy path: the trimmed result field', () => {
    expect(parseResult(OK, '', 0)).toBe('hello world');
  });
  test('an older CLI without json output: stdout is the reply', () => {
    expect(parseResult('plain answer\n', '', 0)).toBe('plain answer');
  });
  test('is_error surfaces the subtype and message', () => {
    const err = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'boom' });
    expect(() => parseResult(err, '', 0)).toThrow(/error_max_turns — boom/);
  });
  test('non-zero exit carries stderr', () => {
    expect(() => parseResult('', 'error: unknown option', 1)).toThrow(/exited 1: error: unknown option/);
  });
  test('a signed-out CLI gets the actionable message, whichever channel says so', () => {
    expect(() => parseResult('', 'Not logged in · Please run /login', 1)).toThrow(/not signed in/);
    const err = JSON.stringify({ is_error: true, result: 'Invalid API key · Please run /login' });
    expect(() => parseResult(err, '', 0)).toThrow(/not signed in/);
  });
  test('killed by signal reads as such', () => {
    expect(() => parseResult('', '', null)).toThrow(/exited by signal/);
  });
});

describe('unwrapCmdShim', () => {
  const SHIM = '@ECHO off\r\n"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
  test('a shim whose target is missing on disk yields null (never a launch that will ENOENT)', () => {
    expect(unwrapCmdShim('C:\\npm\\claude.cmd', SHIM, 'C:\\node.exe')).toBeNull();
  });
  test('no node → null even for a well-formed shim', () => {
    expect(unwrapCmdShim('C:\\npm\\claude.cmd', SHIM, null)).toBeNull();
  });
  test('a file that is not an npm shim → null', () => {
    expect(unwrapCmdShim('C:\\x\\claude.cmd', '@echo hi', 'node')).toBeNull();
  });
});

describe('candidatePaths', () => {
  test('an explicit override comes first, and the well-known installer path is always probed', () => {
    const paths = candidatePaths({ SWARM_CLAUDE_BIN: '/opt/claude/bin/claude' }, '/home/u');
    expect(paths[0]).toBe('/opt/claude/bin/claude');
    if (process.platform !== 'win32') {
      expect(paths).toContain('/home/u/.local/bin/claude');
    }
  });
  test("the IDE's SCELO_CLAUDE_BIN is honoured too", () => {
    const paths = candidatePaths({ SCELO_CLAUDE_BIN: '/x/claude' }, '/home/u');
    expect(paths[0]).toBe('/x/claude');
  });
  test('no duplicates', () => {
    const paths = candidatePaths({}, '/home/u');
    expect(new Set(paths).size).toBe(paths.length);
  });
});
