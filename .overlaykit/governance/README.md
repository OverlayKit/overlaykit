# OverlayKit Development Governance

This directory is a contract, not a collection of mutable notes.

- `decisions/` contains immutable ADR records. An accepted record is never edited.
- `profile.json` selects the accepted decisions that currently govern.
- `profile.json` also declares external trust anchors; observations cannot choose their own trust.
- `mechanisms.json` names the concrete mechanisms a gate may bind to.
- `changes/` contains typed change contracts with claims, criteria, and evidence.
- `schemas/` defines the accepted input vocabulary.
- `plan.json` and `manifest.json` are generated artifacts.

Run:

```bash
npm run governance:compile
npm run governance:check
npm run governance:ruleset:plan -- --out artifacts/github-ruleset-plan.json
```

The compiler has no clock, network, or mutable state. Evidence is represented separately as a
governance run and is current only when its `profileHash`, `planHash`, and `manifestHash` match the
compiled contract and its execution subject matches the expected repository, commit, ref, event,
and pull request. A run may pass a gate only when its producer matches the mechanism compiled into
the plan. Local runs therefore cannot satisfy gates owned by GitHub Actions.

Hashes establish integrity and freshness, not identity authenticity. GitHub attestations and
repository rules are the external root of trust. The GitHub observer records workflow, check,
signature, attestation, and ruleset facts against the compiled trust anchor. Missing protections
remain activation blockers; observation alone never promotes a deferred mechanism.

Ruleset activation is a two-step governed operation. `governance:ruleset:plan` is pure and derives
the exact create payload from the compiled trust anchor. `governance:ruleset:apply` is create-only
and requires an attested successful push run for the protected branch, explicit confirmation of
both hashes, and equality between that run, local HEAD, and the live GitHub ref. It refuses to
update, adopt, or delete an existing ruleset. After creation it observes GitHub again and emits a
receipt only when `activationReady` is true.

Memory Cloud and conversational context can preserve lessons, but they are not normative law.
