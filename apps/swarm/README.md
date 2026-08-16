# SWARM COUNCIL

A decision-support cockpit. The professor inputs a finance / investment scenario, two simulated populations deliberate, and the system surfaces multi-perspective input — consensus, dissent, and reasoning. **The system does not make decisions. It surfaces inputs so the professor can decide.**

## What the swarm does

- **Council of 256 professionals** — 8 professions × 16 MBTI types × 2 genders. Three rounds of deliberation per agent: independent view, peer-aware debate, final structured vote. Surfaces consensus, dissenters, clustered top risks.
- **Society simulator of up to 1000 ordinary people** — parameterised by age distribution, income bands, education, urban/rural split, risk tolerance, employment mix, financial literacy, cultural context. k-means clustering into demographic groups; per-agent sentiment + reaction.
- **Context-aware chatbot** — token-streamed answers grounded in the run state; cites agents by id; computes from data, does not invent.
- **IAAI Canon ingestion** — pulls Prof IAAI's published works from Google Scholar (fallback: manual JSON / BibTeX paste or upload). Condensed canon auto-injects into every council agent's system prompt.

## Stack

- **Runtime:** [Bun](https://bun.sh) only — no Node, npm, pnpm, or yarn.
- **Frontend:** React 18 + Vite + TypeScript with **custom CSS only** (no Tailwind, no shadcn, no MUI, no styled-components).
- **Charts:** Apache ECharts 5 (force layout).
- **Backend:** single Bun server with route handlers + `bun:sqlite`.
- **LLM providers:** local Ollama by default; a signed-in [Claude Code](https://claude.com/claude-code) CLI on the same machine is picked up automatically (no key — it spends the user's Claude plan); user-supplied keys for Anthropic, OpenAI, Gemini, and Hugging Face are held in browser localStorage and pushed to the server in memory only — never written to disk, never logged.

## Quick start

```bash
# install
cd ~/projects/swarm-council
bun install

# in one terminal: start the API
bun src/server/index.ts          # serves http://localhost:3000

# in another terminal: start the UI
bun run dev:client               # serves http://localhost:5180
```

Open the UI, type or paste a scenario, press `Cmd+Enter` (or `Ctrl+Enter`).

Production build:

```bash
bun run build                    # outputs to dist/
```

## Requirements

- Bun >= 1.3
- (Recommended) [Ollama](https://ollama.com) running at `http://localhost:11434` with at least one instruction-tuned model. The router auto-picks the largest available, preferring `gemma3`, then `qwen2.5`, then `llama3.1`, `llama3.2`, `qwen2.5vl`, `gpt-oss`. A 7B-class model is the sweet spot for local council runs.
- (Optional) [Claude Code](https://claude.com/claude-code) installed and signed in (`claude` on PATH or in `~/.local/bin`). Detected at boot and from the Settings modal's **re-detect** button; council and chat prefer it over Ollama when no cloud key is set.
- (Optional) API keys for any of: Anthropic Claude, OpenAI, Google Gemini, Hugging Face — added through the Settings modal.

## Repository layout

```
src/
  shared/                    # types + constants used by both sides
  server/
    index.ts                 # Bun.serve + routes
    db.ts                    # bun:sqlite schema + connection
    runs.ts                  # run lifecycle, SSE pump, persistence
    chat.ts                  # chatbot context builder + stream
    iaai.ts              # Scholar fetch, BibTeX/JSON parse, canon
    agents/
      personas.ts            # 256-agent deterministic generator
      council.ts             # 3-round orchestration
      society.ts             # 1000-agent batched simulator
      society_cluster.ts     # k-means + intra-cluster edges
      edges.ts               # council agreement edges
      synthesizer.ts         # stance/risk synthesis
    llm/
      router.ts              # LLMRouter + semaphores + cache
      cache.ts               # sha256(prompt+model) -> SQLite
      ollama.ts              # local provider (streaming)
      claudeCode.ts          # the signed-in `claude` CLI, headless (-p), no key
      claude.ts openai.ts gemini.ts hf.ts
  client/
    main.tsx App.tsx styles.css
    lib/api.ts               # fetch + SSE helpers
    components/              # 11 UI components
data/                        # runtime SQLite + canon stub (gitignored)
```

## Documentation

- [INSTRUCTIONS.md](./INSTRUCTIONS.md) — detailed walkthrough, provider setup, API reference, tuning, troubleshooting.

## License

Private. All rights reserved.
