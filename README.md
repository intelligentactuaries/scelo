<div align="center">
  <img src="logo/scelo.svg" alt="Scelo" width="120" />

# Scelo

**Soft data → Tools → Hard data.**

</div>

---

Scelo is a desktop workbench for actuaries who want AI-assisted analysis
without sending client data to a cloud. You ask a question in plain
English, the right specialist runs the right model, and the result
comes back in a form your regulator can trace.

The mark says what the system is: three nodes on one axis. Left is
**soft data** ⏤ what you can't easily see or decide on. Middle is the
**tools / brain layer** ⏤ the statistical and actuarial models that
transform soft into hard. Right is **hard data** ⏤ board-pack-ready,
defensible, reproducible.

This repository is currently the public face of the project. The
working source code is developed inside the wider Intelligent
Actuaries monorepo and will be split into a self-contained app here
in due course (see *Status* below).

## What's in this repository

| Path | What |
|---|---|
| [`LICENSE`](LICENSE) | Scelo IDE Source-Available License v1.0. Free up to ZAR 1,000,000 in revenue worldwide; free without limit for nanoeconomics-for-poverty-eradication work; commercial licensing above that. See [License](#license) below. |
| [`ONBOARDING.md`](ONBOARDING.md) | Orientation for contributors. Architecture, the bus pattern, the migrations registry, the templates tree, dev / build / test commands. |
| [`logo/`](logo/) | The Scelo mark as both a standalone SVG and a React component. |

## Status

> *Active development. Pre-1.0. No public binaries yet.*

The Scelo IDE is currently in the polish phase of its v1 cycle. The
core of the IDE is complete:

- Bundled Python 3.13 and R 4.3 runtimes, Pyright and R-LSP language
  servers, ripgrep, git plumbing
- Monaco-based editor with file tree, terminal, search, source
  control, problems panel, tests panel
- Workspace-scoped AI panel (Ollama default; bring-your-own Claude /
  OpenAI / Gemini / OpenAI-compat key in the OS keychain)
- Soft → tools → hard pipeline as the canonical model view, with three
  scoped chatbots and a reference Hard Data workstation that ties out
  to the **Swarm** (256-agent council + 1000-agent society simulator)
- Sample workspace scaffolds (`life-pricing`, `climate-risk`,
  `scelo-brain`, `reserving`) you can spin up in one click
- Data-aware viewers for CSV, Markdown, and Jupyter notebooks
- Per-workspace session persistence: nothing clears unless you ask

What remains before this repository becomes the canonical home:

- [ ] Extract the Scelo source from the monorepo into a self-contained,
      build-passable app here.
- [ ] Real signing certificates (Apple Developer + Windows EV). These
      are paid prerequisites; until they're in place, installer
      artefacts ship unsigned and Gatekeeper / SmartScreen warn on
      first launch.
- [ ] First public release notes + signed installer artefacts on the
      *Releases* tab.
- [ ] Flip this repository from private to public.

## Concepts

### The pipeline

```
                   ┌─────────────┐
   soft data  ───▶ │ brain layer │ ───▶  hard data
                   │   (tools)   │
                   └─────────────┘
```

One-way edges only. Soft never writes to hard directly; hard never
reads from soft. The tools layer is where the audit trail lives.

### Nanoeconomics carve-out

Anyone using Scelo for **nanoeconomics-for-poverty-eradication** work,
based on the published Nanoeconomics Methodology, can use it free of
charge with no revenue cap. Conditions and the annual-report
mechanics are in [LICENSE](LICENSE) §3. Submissions go to both:

```
scelo@intelligentactuaries.com
nanoeconomics@scelo.ai
```

## License

[Scelo IDE Source-Available License v1.0](LICENSE).

In short:

| Who you are | What you owe |
|---|---|
| Anyone with worldwide Gross Revenue under **ZAR 1,000,000** per year | Nothing. Free for any use, including commercial. |
| Anyone above that threshold | A [Commercial License](mailto:legal@intelligentactuaries.com), unless the use qualifies under the Nanoeconomics carve-out below. |
| Anyone applying the published Nanoeconomics Methodology to **poverty-eradication work** | Free regardless of revenue, conditional on a public annual report submitted to both `scelo@intelligentactuaries.com` and `nanoeconomics@scelo.ai`. |
| Anyone who tries to dodge either of the above | Auto-termination + retroactive back-charge at the standard commercial rate + legal costs. |

The license is global. The Licensor is incorporated in the Republic
of South Africa, contract is governed by South African law, but
disputes default to ICC arbitration and the Licensor can enforce IP
rights in any competent court worldwide. Read the full text — it
covers attribution, prohibited acts, the abuse remedy, warranty
disclaimer, liability cap, and consumer-protection carve-outs.

⚠️ **Not legal advice.** Before relying on this license, consult
counsel in your jurisdiction.

## Contact

| Topic | Where |
|---|---|
| Scelo general | scelo@intelligentactuaries.com |
| Commercial licensing | legal@intelligentactuaries.com |
| Nanoeconomics carve-out (Annual Report) | scelo@intelligentactuaries.com **and** nanoeconomics@scelo.ai |
| Lab | hello@intelligentactuaries.com · [intelligentactuaries.com](https://intelligentactuaries.com) |

---

<sub>Scelo is a project of [Intelligent Actuaries (Pty) Ltd](https://intelligentactuaries.com).
Public methodology, private mandate.</sub>
