# OverlayKit Development Governance

This directory is a contract, not a collection of mutable notes.

- `decisions/` contains immutable ADR records. An accepted record is never edited.
- `profile.json` selects the accepted decisions that currently govern.
- `mechanisms.json` names the concrete mechanisms a gate may bind to.
- `changes/` contains typed change contracts with claims, criteria, and evidence.
- `schemas/` defines the accepted input vocabulary.
- `plan.json` and `manifest.json` are generated artifacts.

Run:

```bash
npm run governance:compile
npm run governance:check
```

The compiler has no clock, network, or mutable state. Evidence is represented separately as a
governance run and is current only when its `profileHash`, `planHash`, and `manifestHash` match the
compiled contract. A run may pass a gate only when its producer matches the mechanism compiled into
the plan. Local runs therefore cannot satisfy gates owned by GitHub Actions.

Hashes establish integrity and freshness, not identity authenticity. GitHub attestations and
repository rules are the external root of trust; those mechanisms stay deferred until an observer
can verify them.

Memory Cloud and conversational context can preserve lessons, but they are not normative law.
