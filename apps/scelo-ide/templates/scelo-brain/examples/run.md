# End-to-end run

Wire all three layers together in the terminal:

```bash
bun src/soft.ts                 # ok validation
bun src/tools.ts | python src/hard.py
cat artefacts/claims.csv        # one new row
```

The pipe between `tools.ts` and `hard.py` is the soft -> tools -> hard
contract in one line: the only path into `claims.csv` runs through a
tool envelope that passed soft-layer validation.
