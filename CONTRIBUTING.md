# Contributing to Scelo

Thanks for taking the time. Scelo is in active development before its
v1 public release; this document covers reporting bugs / concerns,
proposing changes, and the licensing terms your contribution lands
under.

## Reporting a bug, a concern, or an issue

Three channels — pick whichever fits. All three are read by the
maintainers.

| Channel | When to use it |
|---|---|
| [GitHub Issues](https://github.com/intelligentactuaries/scelo/issues) | Reproducible bugs, feature requests, UX papercuts. Public once we flip the repo to open. Searchable, threadable, link-able from PRs. |
| **bugs@scelo.ai** | Bug reports you'd rather not have indexed (eg involving partially-redacted client data, screenshots with sensitive metadata, or an issue you're waiting to disclose responsibly). Same triage flow, no public trace until we agree. |
| **scelo@scelo.ai** + **scelo@intelligentactuaries.com** | General concerns, ethical worries, product feedback, anything that isn't a clean bug report. Both addresses receive copies; one will reply. |

### What helps a bug get fixed quickly

- The **Scelo IDE version** (visible in the Welcome page footer, or in
  `apps/scelo-ide/package.json`).
- Your **operating system** and OS version.
- **Bundled runtime** (Python / R / Ollama) versions if the bug
  involves the bundled stack.
- A **minimal reproduction** — the smallest set of steps that triggers
  the problem.
- The **expected** vs **actual** behaviour.
- Screenshots or screen recordings when the issue is visual.
- The contents of `~/.config/Scelo IDE/logs/` (or the platform
  equivalent) if a process crashed.

For UI / UX bugs, a screenshot is usually enough. For correctness
bugs in actuarial computations, please include the input that
triggered the wrong output and the version of the bundled actuarial
package involved.

## Security disclosures

**Please do not file security issues on GitHub.** See
[`SECURITY.md`](SECURITY.md) for the disclosure flow.

## Proposing a change

For a non-trivial change, open an issue first so we can agree on
direction before you write code. For a one-line fix or a typo, just
send the PR.

The canonical repository is
<https://github.com/intelligentactuaries/scelo>.

### Local setup

Prerequisites: [Bun](https://bun.sh) ≥ 1.1, Node-compatible runtime
(comes with Bun). For the full IDE build you additionally need
[Electron-builder's native build prerequisites](https://www.electron.build/multi-platform-build)
on your platform.

```bash
git clone git@github.com:intelligentactuaries/scelo.git
cd scelo
bun install

# Renderer dev server (browser preview at localhost:5173)
bun run dev:web

# Full Electron dev — builds main + launches the IDE
bun run dev

# Production build (renderer dist + main process compiled)
bun run build

# Packaged installer (Linux AppImage example)
bun run ide:dist:linux
```

See [`ONBOARDING.md`](ONBOARDING.md) for a deeper architecture tour:
the apps/web ↔ apps/scelo-ide IPC contract, the bus pattern, the
migrations registry, the sample-workspace tree, and the un-linted
house rules.

### Before sending a PR

```bash
bun run check    # tsc + biome
bun run test     # bun:test suite
```

…must both pass on your branch.

## Commit style

Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`,
`refactor:`, `test:`). Subject under 72 characters; explain *why* in
the body when it isn't obvious from the diff.

## Licensing of contributions

By submitting any contribution (pull request, patch, issue
attachment, etc.) you agree that the contribution is licensed under
the [Scelo IDE Source-Available License v1.0](LICENSE) ("Inbound =
outbound", §9 of the License). You also grant the Licensor a
perpetual, worldwide, non-exclusive, royalty-free, irrevocable
license to reproduce, prepare derivative works of, sublicense
(including under a Commercial License), publicly display, publicly
perform, and distribute the contribution. You represent that you have
the legal right to make the contribution under these terms.

There is no separate CLA to sign. The license text in §9 is the
contract.

## Code of conduct

Be kind, be specific, and assume the other person is acting in good
faith. We don't have a separate code-of-conduct document yet; if a
specific situation needs one, raise it via
**scelo@intelligentactuaries.com**.
