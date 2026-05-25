# Security Policy

Thank you for taking the time to disclose responsibly.

## Reporting a vulnerability

**Please do not file security issues on the public GitHub tracker.**

Send a private report to one of the channels below. Both reach the
maintainers; one will reply.

| Channel | Use for |
|---|---|
| **security@intelligentactuaries.com** | Recommended for security disclosures. Reviewed within 5 business days. |
| **bugs@scelo.ai** | If the boundary between "bug" and "vulnerability" is unclear, or you want a single inbox. Reviewed within 5 business days. |
| **scelo@intelligentactuaries.com** | General fallback; will be triaged to the security contact. |

### What helps

A useful report typically includes:

- The Scelo IDE version (from the Welcome footer or
  `apps/scelo-ide/package.json`).
- The operating system + version.
- A clear description of the vulnerability and its impact (what an
  attacker could read, modify, or execute).
- Steps to reproduce, ideally with a minimal example.
- Any logs, network traces, or screenshots that show the issue.
- Whether the issue requires user interaction (clicking a link,
  opening a file, installing a workspace template, …) and what kind.

We support responsible-disclosure timelines: by default we ask for
**90 days** between report and any public discussion, but we will
negotiate shorter / longer windows for serious issues if the
disclosure can be coordinated.

## Scope

The following surfaces are in scope for security reports:

- **The Scelo IDE** (Electron main process, preload bridge, renderer
  in this repository).
- **Sample workspace scaffolds** shipped under
  `apps/scelo-ide/templates/`.
- **The Scelo brain layer** under `apps/web/src/components/Scelo/`.

The following are explicitly **out of scope** for this repository:

- The third-party bundled runtimes (Python 3.13, R 4.3, Ollama,
  ripgrep, Pyright, R languageserver, Monaco) — please report
  upstream.
- The swarm-council app (separate repository).
- The wider Intelligent Actuaries monorepo (separate repository, with
  its own [`SECURITY.md`](https://github.com/intelligentactuaries/intelligentactuaries/blob/main/SECURITY.md)).

## What we will do

1. Acknowledge receipt within **5 business days**.
2. Triage and assign a severity.
3. Keep you updated on progress at least every **2 weeks**.
4. Credit you (or pseudonymously per your preference) in the release
   notes for the fixing version, unless you ask us not to.
5. Coordinate the public disclosure timing with you.

We do not currently run a paid bug-bounty programme. If that changes,
this document will be updated.

## What we ask in return

- Don't run automated scanners that generate substantial traffic
  against production infrastructure without prior arrangement.
- Don't access user data beyond what's needed to demonstrate the
  vulnerability.
- Don't destroy, exfiltrate, or modify data.
- Give us a reasonable window to fix before public disclosure.
- Disclose any third-party tools / services involved in your testing.
