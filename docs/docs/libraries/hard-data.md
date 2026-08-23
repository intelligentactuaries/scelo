# Hard data & reports

The right-hand end of the pipeline: stamp a table so it can travel,
verify it later, assemble a board pack, and read back the ledger of
everything the tools layer did. This is the one-way rule — soft data →
tools → hard data — made mechanical.

## The audit ledger

Every tools-layer call is recorded as it happens: the function, its
arguments (frames summarised by shape and hash), the input and output
content hashes, and the wall time.

=== "Python"

    ```python
    sc.audit()            # the session ledger, most recent last
    sc.audit(5)           # just the tail
    sc.clear_audit()      # a new deliverable, a clean slate
    sc.enable_audit(False)  # off (and back on) for tight loops
    ```

=== "R"

    ```r
    sc_audit()
    sc_audit(5)
    sc_clear_audit()
    sc_enable_audit(FALSE)
    ```

```text
                           at        fn  ...              in       out    ms
0   2026-08-23T20:04:42+00:00      load  ...            None  52a022c2…   2.1
1   2026-08-23T20:04:42+00:00  triangle  ...      52a022c2…   1b774e0b…   3.4
2   2026-08-23T20:04:42+00:00      mack  ...      1b774e0b…   18cc78c4…   5.0
```

The hashes chain: `triangle`'s output hash is `mack`'s input hash. That
chain is what `hard` seals into a table.

## Stamping

=== "Python"

    ```python
    t = sc.hard(sc.mack(tri).table, assumptions={"tail": 1.0})
    t.provenance
    # {'sha256': '18cc78c4c8676f59…', 'at': '2026-08-23T20:04:57+00:00',
    #  'scelo': '0.1.0', 'python': '3.13.12', 'pandas': '3.0.5',
    #  'rows': 8, 'columns': [...],
    #  'trail': [{'fn': 'load', …}, {'fn': 'triangle', …}, {'fn': 'mack', …}],
    #  'assumptions': {'tail': 1.0}}
    sc.verify(t)          # True — and False the moment any cell is edited
    ```

=== "R"

    ```r
    t <- sc_hard(sc_mack(tri)$table, assumptions = list(tail = 1.0))
    sc_provenance(t)
    sc_verify(t)          # TRUE — FALSE the moment any cell is edited
    ```

`hard` stamps the content hash (SHA-256 of the values in Python; MD5 of
the CSV rendering in R — each verified by its own `verify`), the UTC
timestamp, the library and runtime versions, the shape, the **last
twelve audit entries** as the call trail, and any assumption set you
attach. The stamp survives subsetting and travels with `.md` / `.html`
exports; editing a single cell breaks `verify`, which is the point.

## Board packs

=== "Python"

    ```python
    sc.report(reserves, sc.life_table(), "## Method\n\nProse goes here.",
              title="Q3 reserving pack", summary="IBNR up 4 % on Q2.",
              author="A. Denewade", to="pack.html")
    ```

=== "R"

    ```r
    sc_report(reserves, sc_life_table(), "## Method\n\nProse goes here.",
              title = "Q3 reserving pack", summary = "IBNR up 4 % on Q2.",
              author = "A. Denewade", to = "pack.html")
    ```

`report` takes any mix of Tables, plain frames, model results and
Markdown strings, stamps anything not yet hard, and writes one document:
title and generation line, executive summary, every table with its basis,
notes and hash, and the audit trail at the back. `.html` gets the IDE's
cream-and-ink styling with no external dependency; anything else is
returned as Markdown. Writes are atomic — a crash never leaves half a
pack.

## Exports and snapshots

=== "Python"

    ```python
    sc.export(t, "reserves.csv")      # CSV / TSV / parquet / xlsx / json / md / html
    sc.snapshot(df, "post_cleaning")  # a named, hashed copy under ~/.scelo/snapshots
    sc.restore("post_cleaning")
    sc.snapshots()                    # name, at, rows, cols, hash
    ```

=== "R"

    ```r
    sc_export(t, "reserves.csv")
    sc_snapshot(df, "post_cleaning")
    sc_restore("post_cleaning")
    sc_snapshots()
    ```

Snapshots live under `$SCELO_HOME/snapshots` (default `~/.scelo`), each
with a JSON sidecar recording when it was taken, its shape and its hash —
and the two languages read each other's snapshots, so a frame snapshotted
in Python restores in R.

## Function list

`hard` `provenance` `verify` `export` `report` `snapshot` `restore`
`snapshots` · `audit` `clear_audit` `enable_audit` `content_hash` — each
with the `sc_` twin in R.
