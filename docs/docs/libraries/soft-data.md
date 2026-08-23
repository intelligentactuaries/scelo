# Soft data

The intake desk as functions: load a file, understand it, get it clean and
shaped before it goes near a model. Every threshold here is the IDE's own
— the library and the Soft Data banner propose the same ops on the same
file.

## Loading

=== "Python"

    ```python
    df = sc.load("claims.csv")            # CSV / TSV / TXT — delimiter sniffed
    df = sc.load("book.parquet")          # parquet, feather   (pip install "scelo[io]")
    df = sc.load("extract.xlsx", sheet=0) # Excel              (openpyxl)
    df = sc.load("big.csv", rows=50_000, seed=1)   # uniform row sample on read
    ```

=== "R"

    ```r
    df <- sc_load("claims.csv")           # CSV / TSV / TXT — delimiter sniffed
    df <- sc_load("big.csv", rows = 50000, seed = 1)
    ```

Loading applies the IDE's import-time cell rule: `""` and short missing
tokens (`NA`, `null`, `-`, …) become null, strictly numeric strings become
numbers, and everything else stays text — so `"007"` and IDs longer than
2⁵³ − 1 survive as strings. Headers are trimmed; blanks become `column`;
duplicates get `_2`, `_3`. A file that is not delimited text says so
instead of producing one silly column.

`sc.save(df, "out.csv")` / `sc_save(df, "out.csv")` write the other way —
CSV, TSV, RDS/parquet, JSON, Markdown or HTML by extension, always
atomically (a `.partial` file is renamed into place, so a crash never
leaves half a file). `sc.reservoir(df, n)` / `sc_reservoir(df, n)` is the
IDE's uniform row sample with provenance in the frame's attributes.

Six bundled datasets let every example in this manual run as written:
`sc.sample("claims")`, `"dirty"`, `"climate"`, `"wmtr-scenarios"`,
`"lifelib-mp"`, `"workspace-demo"` — described under
[the command line](cli.md#samples-and-the-map).

## Looking

=== "Python"

    ```python
    sc.profile(df)      # per column: type, missing, unique, five-number summary,
                        # Tukey fences, outliers, top values, histograms
    sc.describe(df)     # numeric columns: Bessel sd, type-7 quantiles, G1/G2 shape,
                        # Jarque–Bera, ranked by coefficient of variation
    sc.tab(df, "Region")            # Stata's tab: counts and percentages
    sc.tab(df, "Region", "active")  # two-way, with margins
    sc.missing(df)      # missing counts, worst first
    sc.corr(df, min_abs=0.3)        # correlations, weak cells blanked
    sc.outliers(df, "age")          # the rows outside the fences
    ```

=== "R"

    ```r
    sc_profile(df)
    sc_describe(df)
    sc_tab(df, "Region")
    sc_tab(df, "Region", "active")
    sc_missing(df)
    sc_corr(df, min_abs = 0.3)
    sc_outliers(df, "age")
    ```

```text
        column   n  missing  ...   kurtosis  jarque_bera      jb_p
0          age  53        0  ...  46.968060  4362.473270  0.000000
1       active   8       45  ...  -2.800000     1.333333  0.513417
2  premium_zar  23       30  ...  -1.090373     1.810857  0.404369
— describe · 53 rows
  · 3 numeric columns profiled: sample moments (Bessel), type-7 quantiles, G1/G2 shape,
    Jarque–Bera normality.
  · Widest relative spread is `age` (CV 11.87): mean 119.9, sd 1423, range [-999, 9999].
  · 2 column(s) are >10% missing/non-numeric: worth resolving before any fit.
```

The statistics match the IDE cell for cell: type-7 quantiles, Bessel's
sd, adjusted Fisher–Pearson G1/G2, and a closed-form Jarque–Bera — a
median printed here is the median the IDE would print for the same file.
A column with zero IQR classifies no outliers, so a discrete column never
lights up a quarter of its rows.

## Cleaning

The IDE's cleaning banner, as data and as functions. Eighteen ops in two
tiers: **nine safe ops** that cannot lose information, and nine that can
(dedupe, drop, impute, cap, rename).

=== "Python"

    ```python
    sc.suggest(df)              # the plan: one row per op, with cells touched, evidence, safe flag
    clean = sc.clean(df)        # the 9 safe ops, one pass
    clean = sc.clean(df, "all") # everything, up to 8 passes, until clean or stalled
    clean = sc.clean(df, ["trim", "dates", "sentinels"])   # exactly these (aliases fine)
    ```

=== "R"

    ```r
    sc_suggest(df)
    clean <- sc_clean(df)
    clean <- sc_clean(df, "all")
    clean <- sc_clean(df, c("trim", "dates", "sentinels"))
    ```

```text
                           op  ...                                                why
0                fix-encoding  ...            mojibake, NBSP or zero-width characters
1         collapse-whitespace  ...                        runs of internal whitespace
2              missing-tokens  ...                            missing markers: ?, TBD
3               parse-numeric  ...                   ≥ 80 % of cells parse as numbers
4                 parse-dates  ...                    ≥ 80 % of cells are date-shaped
5        standardise-booleans  ...          two boolean spellings, ≤ 5 % other values
...
— cleaning plan · 12 op(s) · 53 rows × 11 cols
  · 7 safe op(s) run with clean(df); 5 need clean(df, "all") or an explicit list.
```

| Safe op | What it fixes |
|---|---|
| `fix-encoding` | mojibake (`Ã©` → `é`), NBSP → space, BOM / zero-width characters dropped |
| `trim` | leading / trailing whitespace |
| `collapse-whitespace` | runs of internal whitespace |
| `missing-tokens` | 40 markers (`N/A`, `?`, `TBD`, `#DIV/0!`, `—`, …) → null |
| `standardise-booleans` | mixed `Y/N/yes/no/TRUE/1` → real booleans |
| `parse-dates` | date-shaped text → dates; day-first inferred per column from the unambiguous cells |
| `parse-numeric` | `$1,234` · `(1,200)` → −1200 · `85%` → 85 (kept as displayed) · `1 200 ZAR` |
| `coerce-numeric` | keeps the numeric prefix of `"6+"`, nulls the digit-free rest |
| `replace-numeric-sentinels` | recurring `-999` / `9999` codes ≥ 5 IQR outside the body → null |

| Unsafe op (needs `"all"` or an explicit list) | What it does |
|---|---|
| `drop-duplicates` | exact duplicate rows |
| `drop-empty-cols` / `drop-constant-cols` | > 95 % missing / single-valued columns — never all of them |
| `lowercase-categoricals` | `WEST` / `west` / `West` → one bucket |
| `rename-snake-case` | headers to `snake_case`; abandoned entirely if two would collide |
| `cap-outliers` | winsorise to the Tukey fences; auto-mode skips year and ID columns |
| `impute-missing` | median / mode with a `was_missing_*` indicator; refuses dates, IDs, near-empty columns |
| `recode-value` / `null-future-years` | one exact value; impossible future years |

The cleaned Table's notes list literally what changed —
`sentinels → null: age (6 cells)` — and end with the shape transition
(`53×11 → 50×12 · clean`). Safe ops never drop a row or a column, and the
input frame is never modified in place.

The scalar rules are exported too: `sc.parse_number("(1,234)")`,
`sc.parse_date("5 Jan 2024")`, `sc.snake_case("Customer Name")` /
`sc_parse_number()`, `sc_parse_date()`, `sc_snake_case()`.

## Combining

=== "Python"

    ```python
    sc.suggest_combine(a, b)    # append or join-left? key? confidence? the evidence
    sc.combine(a, b)            # do what the suggestion says, noting each step
    sc.join(a, b, key="policy_id")   # explicit left join — first right match wins
    sc.append(a, b)             # stack, columns matched case-insensitively
    sc.diff(a, b, key="policy_id")   # cell-level differences
    sc.tieout(a, b, tol=1e-6)   # True when two results agree — for checking a rebuild
    ```

=== "R"

    ```r
    sc_suggest_combine(a, b)
    sc_combine(a, b)
    sc_join(a, b, key = "policy_id")
    sc_append(a, b)
    sc_diff(a, b, key = "policy_id")
    sc_tieout(a, b, tol = 1e-6)
    ```

Join semantics are the IDE's: the key is matched case-insensitively as
text, **the first right-hand match wins** so a join never multiplies rows,
and clashing column names get `_2`, `_3`. The suggestion's confidence and
the counts of matched and unmatched rows land in the notes.

## Column inference

Every frame-first function infers the columns it needs from a shared
alias list of 24 roles — `origin` matches `accident_year`, `AY`,
`uw_year`, `cohort`…; `value` matches `paid`, `incurred`, `loss`,
`amount`… Matching ignores case and punctuation, and the first alias that
matches wins. When inference fails, the error names the role, what it
tried, and the columns it saw:

```text
KeyError: could not infer the origin column: pass origin=<name>.
Tried origin, origin_year, accident_year, ay, uw_year, underwriting_year…;
columns: ['policy', 'year_written', 'devq', 'gross']
```

`sc.find_column(df.columns, ["age", "age_at_entry"])` /
`sc_find_column(names(df), c("age", "age_at_entry"))` expose the matcher
for your own functions.
