# Exporting

Everything you do in Scelo is reproducible. Two kinds of output: **runnable
code** and the **board-pack PDF**.

## Code export

**export · code** is available on every stage (Soft, Tools, Hard) and as
**EXPORT · WHOLE PIPELINE** on the macro view. It turns your actions — the
cleaning ops you applied, the date reformats, the derived columns, the models
you picked, the runs — into a script.

Choose the language:

- **Python** — pandas + the actuarial stack (chainladder, …).
- **R** — tidyverse + ChainLadder, …
- **C++** — a scaffold with the steps as comments / TODOs.
- **Prompt** — a natural-language description of the whole flow, for handing to
  another tool.

The export reads from an **activity log** that records each step (cleaning,
date reformat, per-column clean, derived column, model run, data augmentation,
…), so the script mirrors exactly what you did.

!!! example "What a cleaning + reformat looks like in Python"
    ```python
    # Cleaning ops applied via the banner:
    #   • trim whitespace
    #   • normalise missing markers
    for c in df.select_dtypes(include='object').columns:
        df[c] = df[c].astype(str).str.strip()
    df = df.dropna(axis=1, how='all')
    df = df.drop_duplicates()
    # Reformat date column(s) to American (MM/DD/YYYY):
    df["joined_date"] = pd.to_datetime(df["joined_date"], errors="coerce").dt.strftime("%m/%d/%Y")
    ```

## Dataset export

**export ▾** in Soft Data writes the current (cleaned) dataset back out as
**CSV** or **Parquet**.

## The board-pack PDF

In Hard Data, the **Board Pack** node (**⤢**) or the **report · pdf** toolbar
button opens a printable report — executive summary, estimates (forest plot),
trajectory, and a per-model breakdown — with a **download pdf** button. See
[Hard Data](pipeline/hard-data.md#the-board-pack).
