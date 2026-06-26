# Chat

Scelo's AI is not one chatbot — it's a set of **scoped assistants** that appear
where you're working, each framed for that context.

## Where the chats are

| Chat | Where | Scoped to |
| --- | --- | --- |
| **Stage chat** | Bottom of each workstation (Soft / Tools / Hard) | That stage's job |
| **Macro-node chat** | On each card in the macro view | That stage, briefly |
| **Column chat** | Hover a column header in Soft Data | That one column |
| **Model chat** | On each model node in Tools | That model |
| **Result chat** | In a model's detail dashboard in Hard | That result |

Each is framed so the assistant stays useful and on-task — the Soft chat won't
jump ahead to model choice, the Hard chat won't re-open data collection, and so
on.

## Deterministic local commands

Some requests are handled **client-side, instantly, with no provider call** — so
they work even fully offline. In the Soft Data chat:

- `clean my data` / `do the initial cleaning` — runs the cleaning plan.
- `make the dates american` (or european / iso) — reformats date columns.
- `add 1000 rows through augmentation` — bootstrap augmentation.

In a **column** chat:

- `make this american`, `remove all non-dates`, `clean this column`.

Anything that isn't one of these falls through to the normal AI chat.

## Rendering

Replies render as **markdown**: inline code, lists, tables, and math (KaTeX).
The Soft/Hard chats can also render embedded **`viz` blocks** — the assistant
returns a small chart or stat-table spec that Scelo draws against your current
dataset.

## Provider

The chat uses whichever [AI provider](ai-providers.md) is active — Ollama by
default. In the desktop app the request goes directly to the provider from the
main process.
