# Scelo IDE documentation

The user manual for the Scelo IDE, built with [MkDocs Material](https://squidfunk.github.io/mkdocs-material/).
Canonical home: **https://docs.intelligentactuaries.com/**

## Develop

```bash
python -m venv .venv && . .venv/bin/activate
pip install mkdocs-material
mkdocs serve          # live preview at http://127.0.0.1:8000
```

## Build

```bash
mkdocs build --strict # output in site/ (git-ignored)
```

## Conventions

- **Brand colours** — IA warm cream (light, default) / warm charcoal (dark),
  defined as Material CSS tokens in `docs/stylesheets/extra.css`.
- **Diagrams** — inline SVG in the IA brand iconography language (single-stroke,
  monochrome, `currentColor`), wrapped in `<figure class="ia-diagram">`.
- **Screenshots** — `docs/assets/img/`, embedded with `{ .shadow }`.
