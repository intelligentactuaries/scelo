# Running the swarm on Windows (so the Scelo IDE's swarm tab works)

The **Scelo IDE does not bundle the swarm.** Its `/swarm` view is just an
`<iframe>` pointed at **`http://localhost:5190`** (`SwarmPanel.tsx` →
`swarmBus.ts`). Every Scelo-specific surface lives in **this** app — the private
`swarm-council` fork — and the IDE simply embeds whatever is served on that port.

So if the Windows IDE is "missing tabs," it is almost never an IDE-build problem.
It means this companion app is **not running on 5190**, or an **older / upstream**
swarm is running there instead. Rebuilding the IDE `.exe` will not add these
surfaces — they are never in it by design.

## The surfaces this app adds (what "the missing tabs" actually are)

| In the IDE you'd call it | Component here | What it is |
|---|---|---|
| the **forecast** tab | `src/client/components/ForecastCanvas.tsx` | forecast canvas surface |
| **simulation** | `src/client/components/SimulationView.tsx` | society simulation view |
| **readback** | `src/client/components/WmtrStrip.tsx` | the WMTR read-back strip |
| the **IAAI Canon** | IAAI Canon ingestion (Prof IAAI's works → condensed into every council agent's prompt) | see README |

If none of these show up in the Windows IDE, run the steps below on the Windows
machine.

---

## Run it on Windows

This is the **dev** app (Vite + Bun), not a packaged build — you run it from a
checkout, exactly like on Linux. It must serve **UI on 5190** and **API on
`PORT=3010`** (its default is 3000, which the IDE does **not** probe).

### 1. Prerequisites

- **Git for Windows** (installs **Git Bash**) — https://git-scm.com/download/win
- **Bun for Windows** ≥ 1.1 — PowerShell: `irm bun.sh/install.ps1 | iex`
- This app is **Bun-only** — do not use Node / npm / pnpm / yarn.
- Access to the private repo (ask the Intelligent Actuaries team).

### 2. Get the exact code

```powershell
git clone git@github.com:intelligentactuaries/intelligentactuaries.git
cd intelligentactuaries\swarms          # the swarm-council app lives here
git checkout feat/swarm-graph-grouping  # or the SHA running on the Linux box
bun install
```

### 3. Start it on the right ports

⚠️ **PowerShell gotcha.** The `dev` script is
`bun run dev:server & bun run dev:client`, and that `&` is **bash-only** — in
PowerShell `&` is the call operator and won't background the client. Pick one:

**Option A — Git Bash (simplest; identical to Linux):**

```bash
PORT=3010 bun run dev
```

**Option B — two PowerShell windows:**

```powershell
# window 1 — API on 3010
$env:PORT=3010; bun run dev:server
```
```powershell
# window 2 — UI on 5190 (no PORT needed; vite.config.ts pins 5190, strictPort)
bun run dev:client
```

`PORT` is read once, in `src/server/index.ts` (`Number(process.env.PORT ?? 3000)`).
The Vite client port is fixed at **5190** in `vite.config.ts`.

### 4. Verify from the IDE

Open the Scelo IDE → `/swarm` and read the status badge (top-right of the panel):

- **● offline** → nothing on 5190 → start the app (step 3).
- **● live** but tabs missing → the *wrong* / older swarm is on 5190 → stop it and
  run this checkout/branch instead.
- **● live** with Forecast / Simulation / WMTR / IAAI Canon present → done.

The IDE re-probes every 5 s and live-attaches — **no IDE restart needed.**

---

## How the swarm renders

Two graph views carry the grouping the Windows build was missing:

- **Council Reactions** — `src/client/components/CouncilGraph.tsx`, grouped by
  **profession** (8 professions).
- **Society Pulse** — `src/client/components/SocietyGraph.tsx`, grouped by
  **cluster** (k-means demographic clusters).

Both are **ECharts `graph` series**, but deliberately **not** on an ECharts force
layout (which scattered every node into one structureless cloud). Instead they run
our own deterministic layout in plain pixel space and draw the result on a
**hidden `cartesian2d` grid**:

```
grid:  { left:0, right:0, top:0, bottom:0 }          // grid fills the canvas
xAxis: { type:'value', min:0, max:W, show:false }    // pixel x, 0..W
yAxis: { type:'value', min:0, max:H, inverse:true, show:false }  // pixel y, 1:1
series[graph]: { coordinateSystem:'cartesian2d', ... } // node pos = value:[x,y]
```

**Why the hidden cartesian grid matters (the alignment gotcha):** an ECharts
`graph` with `layout:'none'` **auto-fits** node coordinates to the container (it
silently applies a scale + translate `matrix(...)`), so literal-pixel `graphic`
overlays drawn on top do **not** line up with the nodes. Putting the graph on a
cartesian2d grid whose axes span exactly `0..W` / `0..H` makes `value:[x,y]` land
pixel-exact, and — because the axes cover the full grid — top-level `graphic`
elements (also in pixel coords) align **1:1** with the nodes. `yAxis.inverse:true`
maps pixel-y (top-down) to axis-y so nothing is flipped.

Trade-off: **roam (pan/zoom) is removed** to keep that alignment. The layout is
static and deterministic (seeded), rebuilt only on container resize (debounced
~140 ms).

---

## The grouping — nodes inside a greater "node" (shaded hulls)

This is the feature the Windows build wasn't showing: each group's nodes sit
inside a soft, labelled enclosing circle — the "greater node" (a **hull**) — with
edges crossing between hulls. Three pure helpers build it, all in pixel space so
they line up under the cartesian2d nodes:

### 1. `layoutCells()` — `src/client/lib/groupLayout.ts`
Tiles the present groups into a grid of cells filling the `W×H` canvas (column
count ≈ canvas aspect ratio; short final row centred). Each cell gives a group a
**fixed centre** to cluster around.

### 2. `forceClusterLayout()` — the organic clump + the enclosing circle
A small **deterministic (seeded) force sim** — restores the organic force-graph
look while keeping groups separated. Per iteration (260 total, with cooling):

- **same-group repulsion** (`KREP`) — the clump breathes;
- **within-group edge springs** (`KSPRING`, rest length `REST`) — connected nodes
  drift together (cross-group edges are *excluded* so they don't stretch a clump
  and inflate its hull);
- **cohesion** toward the group's fixed cell centre (`KGROUP`) — cross-group
  separation comes from the already-separated centroids, so groups can't drift
  into each other.

It returns each node's settled `pos` **and** a per-group **`groupCircle`** =
`{cx, cy, r}` — the centroid of the group's nodes and the radius that encloses the
farthest member (plus its node radius + padding). **That circle is the "greater
node."**

### 3. `hullGraphics()` / `installGroupHulls()` — draw & make the hull interactive
- `hullGraphics()` (`groupLayout.ts`) — emits, per group, a **translucent circle**
  (`z:0`, behind the nodes) + a **label** above it, in the same pixel space as the
  nodes, so each group reads as a shaded region under its clump.
- `installGroupHulls()` (`src/client/lib/groupHulls.ts`) — owns the ECharts
  `graphic` component and makes each hull a **group** (`id: hull-<key>`, circle +
  label) that is:
  - **draggable** — grab the shaded area or label and every member node rides with
    it (manual window pointer listeners, rAF-throttled; drag offsets reset on any
    full rebuild — new run / resize / theme);
  - **hoverable** — a small DOM tooltip shows that group's edge stats (members,
    dominant stance/sentiment, within-group edge count + avg agreement, cross-group
    edge count).

Hulls are applied with `setOption(..., { replaceMerge: ['graphic'] })` so they
fully replace on rebuild — no stale circles when the group count changes.

### Cross-surface highlighting
The graph ↔ Sankey ↔ legends share one `crossHighlight` bus (`{source, agentIds,
key, locked}`). Hovering a **hull** lights that group's nodes + all attached edges,
greys the rest, fades the other hulls, and drives the Sankey and both legends;
hovering a **legend** chip lights only that entry and greys the others. Legend
click **locks** the selection.

---

## Notes

- **Server-free between runs, but the LLM calls are live** — the council/society
  need whatever provider the app is configured for; a run won't populate the
  graphs without it.
- **`PORT` must be 3010.** The IDE probes `localhost:5190` (UI) whose Vite proxy
  and the IDE's council client both expect the API on **3010**; the app's own
  default is 3000, which nothing probes.
- **Keep this checkout in sync with Linux.** The surfaces only match if the branch
  / commit matches the one running on the Linux box (`git rev-parse HEAD` on both).
