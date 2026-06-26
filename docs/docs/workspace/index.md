# The workspace

Beyond the Scelo pipeline, the IDE is a full **VS Code-style code workspace** —
a Monaco editor, a real terminal with bundled Python and R, language servers,
search, Git, and a workspace AI panel. This is where you write and run the code
your pipeline exports, or any actuarial code of your own.

!!! note "Desktop only"
    The workspace needs the Electron app (the `window.scelo` bridge). In a plain
    browser you'll see a "browser preview — full workspace requires Scelo IDE"
    badge and each panel renders a stub. Everything below assumes the installed
    desktop app.

## Opening a workspace

Open the workspace at **`/workspace`** (or from the welcome screen). The first
time, pick a folder:

- The **FILES** sidebar shows a **choose… / change…** button → native folder
  picker.
- Or run **File: Open Workspace…** (**⌘/Ctrl+O**) from the command palette.
- Switch later with **Workspace: Switch Workspace…** (**⌘/Ctrl+⇧+O**).

Your open tabs, active file, selected sidebar tab, panel widths, terminal
visibility, and AI-panel state are all **saved per workspace** and restored next
time you open it.

## The layout

<figure class="ia-diagram" markdown="0">
<svg viewBox="0 0 760 332" role="img" aria-label="Workspace layout: sidebar on the left, editor and terminal in the centre, AI panel on the right, status bar across the bottom" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
  <!-- window frame -->
  <rect x="20" y="20" width="720" height="292" rx="13"/>
  <!-- header strip -->
  <line x1="20" y1="54" x2="740" y2="54"/>
  <text class="ia-tag" x="40" y="42" fill="currentColor" stroke="none">scelo ide · workspace</text>
  <!-- status bar strip -->
  <line x1="20" y1="276" x2="740" y2="276"/>
  <text class="ia-tag" x="380" y="298" text-anchor="middle" fill="currentColor" stroke="none">status bar</text>
  <!-- sidebar / centre / ai dividers -->
  <line x1="182" y1="54" x2="182" y2="276"/>
  <line x1="598" y1="54" x2="598" y2="276"/>
  <!-- editor / terminal divider -->
  <line x1="182" y1="214" x2="598" y2="214"/>

  <!-- sidebar labels -->
  <text class="ia-tag" x="101" y="86" text-anchor="middle" fill="currentColor" stroke="none">sidebar</text>
  <text class="ia-sub" x="101" y="116" font-size="9" text-anchor="middle" fill="currentColor" stroke="none">files</text>
  <text class="ia-sub" x="101" y="135" font-size="9" text-anchor="middle" fill="currentColor" stroke="none">search</text>
  <text class="ia-sub" x="101" y="154" font-size="9" text-anchor="middle" fill="currentColor" stroke="none">outline</text>
  <text class="ia-sub" x="101" y="173" font-size="9" text-anchor="middle" fill="currentColor" stroke="none">git</text>
  <text class="ia-sub" x="101" y="192" font-size="9" text-anchor="middle" fill="currentColor" stroke="none">problems</text>
  <text class="ia-sub" x="101" y="211" font-size="9" text-anchor="middle" fill="currentColor" stroke="none">tests</text>

  <!-- editor tabs -->
  <rect x="198" y="66" width="62" height="16" rx="4"/>
  <rect x="266" y="66" width="62" height="16" rx="4"/>
  <!-- code lines -->
  <line x1="206" y1="112" x2="320" y2="112"/>
  <line x1="206" y1="132" x2="380" y2="132"/>
  <line x1="206" y1="152" x2="300" y2="152"/>
  <text class="ia-tag" x="390" y="190" text-anchor="middle" fill="currentColor" stroke="none">editor</text>
  <!-- terminal marker -->
  <path d="M206 244 L216 250 L206 256"/>
  <line x1="222" y1="256" x2="262" y2="256"/>
  <text class="ia-tag" x="390" y="252" text-anchor="middle" fill="currentColor" stroke="none">terminal</text>

  <!-- ai panel -->
  <text class="ia-tag" x="669" y="150" text-anchor="middle" fill="currentColor" stroke="none">ai panel</text>
  <text class="ia-sub" x="669" y="170" font-size="9" text-anchor="middle" fill="currentColor" stroke="none">(toggle)</text>
</svg>
</figure>

- **Left sidebar** — six tabs: **FILES, SEARCH, OUTLINE, GIT, PROBLEMS, TESTS**.
  Drag its right edge to resize (180–600px).
- **Center** — open-file tabs, the **editor**, and a collapsible **terminal**
  docked below it.
- **Right** — the **AI panel** (toggle with **⌘/Ctrl+⇧+A**); drag its left edge
  to resize (240–700px).
- **Bottom** — the [status bar](#); toasts appear top-right.

## What's in here

| Page | Covers |
| --- | --- |
| [Editor & files](editor.md) | Monaco editor, language servers, the file explorer, viewers for CSV / Markdown / notebooks |
| [Terminal & runtimes](terminal.md) | The integrated terminal, bundled Python & R, running scripts and tests |
| [Search, Git, Problems, Tests](panels.md) | Find-in-files, Git stage/commit, diagnostics, test discovery |
| [Command palette](command-palette.md) | Quick Open, the command palette, symbol search |

## The workspace AI panel

A code assistant docked on the right, separate from the Scelo stage chats.
Toggle it with **⌘/Ctrl+⇧+A**.

- It uses the same [AI provider](../ai-providers.md) as everything else and keeps
  a **per-workspace conversation** ("Workspace: &lt;folder&gt;").
- **Attach context** (on by default) prepends your current editor selection (or
  the first 40 lines of the active file) so the model sees your code.
- **Send selection** — **⌘/Ctrl+L** stages the selected code into the panel.
- **Apply to file** — under any reply, a fenced code block whose language matches
  the active file gets an **apply block** button that replaces your selection (or
  inserts at the caret). You still save manually.
