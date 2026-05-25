# Scelo brain starter

A minimal soft -> tools -> hard pipeline. Two TypeScript files describe
the contract and the orchestration; one Python file is the deterministic
hard-data writer at the end. The hand-off between layers is the
interesting part : everything else is replaceable.

## The contract

```
soft  : free text / raw numbers from the user or upstream model
        : must be validated before being trusted
tools : deterministic functions the soft layer is allowed to call
        : each tool returns a typed result, never throws on bad input
hard  : the only writer to durable artefacts (DB, CSV, model state)
        : refuses to ingest anything that didn't come through tools
```

One-way edges only. Soft never writes to hard directly; hard never reads
from soft. The tools layer is where you put your audit log.

## Run order

1. `bun src/soft.ts` : feeds a sample soft-data row through validation.
2. `bun src/tools.ts` : exercises the tool registry with the validated row.
3. `python src/hard.py` : writes the deterministic artefact.

## Layout

```
src/soft.ts   : free-form -> typed
src/tools.ts  : tool registry + dispatcher
src/hard.py   : durable writer (the only thing that touches disk in anger)
examples/     : runnable conversation transcript
```
