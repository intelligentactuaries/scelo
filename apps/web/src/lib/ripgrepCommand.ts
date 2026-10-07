// The ripgrep command line Quick Open and Search hand to exec.start, and how
// its paths come back as workspace-relative ones.
//
// exec.start runs a command in the terminal's shell: bash or zsh on Linux and
// macOS, PowerShell on Windows. The two quote differently: POSIX closes the
// quote around an apostrophe ('\''), PowerShell doubles it (''), and
// PowerShell only runs a quoted program path behind its call operator (&).
// rg prints Windows paths with backslashes unless told otherwise; with
// --path-separator / every platform hands back the same shape, which is the
// one the workspace IPC takes.

export function isWindowsHost(): boolean {
  if (typeof navigator === "undefined") return false;
  return /^win/i.test(navigator.platform || "") || /windows/i.test(navigator.userAgent || "");
}

export function shellQuote(s: string, windows: boolean): string {
  return windows ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, "'\\''")}'`;
}

/** `rg <args>` for the platform's shell. `args` are passed through as
 *  written (flags), except those wrapped by `quoted`, which are quoted. */
export function ripgrepCommand(
  rgPath: string | null,
  args: Array<string | { quoted: string }>,
  windows: boolean,
): string {
  const q = (s: string) => shellQuote(s, windows);
  const program = rgPath ? (windows ? `& ${q(rgPath)}` : q(rgPath)) : "rg";
  const rest = args.map((a) => (typeof a === "string" ? a : q(a.quoted)));
  if (windows) rest.unshift("--path-separator /");
  return [program, ...rest].join(" ");
}

/** A path rg printed, relative to the workspace when it lies inside it, with
 *  forward slashes. Windows paths compare without regard to case. */
export function workspaceRelative(
  absPath: string,
  workspacePath: string,
  windows: boolean,
): string {
  const line = absPath.replace(/\r$/, "");
  const fwd = (s: string) => (windows ? s.replace(/\\/g, "/") : s);
  const root = `${fwd(workspacePath).replace(/\/+$/, "")}/`;
  const p = fwd(line);
  const inside = windows ? p.toLowerCase().startsWith(root.toLowerCase()) : p.startsWith(root);
  return inside ? p.slice(root.length) : p;
}
