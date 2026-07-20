# Agent Operating Contract

This repository is governed by the compiled contract in `.overlaykit/governance/`.

Before changing product code, an agent must:

1. Run `npm run governance:verify`.
2. Read `.overlaykit/governance/plan.json`.
3. Identify the active change contract and its ADRs.
4. State its agent identity and human principal.
5. Classify relevant claims as facts, inferences, assumptions, or unknowns.

Facts and inferences require evidence. Blocking unknowns stop an approved or implemented change.
An agent must not edit or delete an accepted decision. It creates a successor decision instead.

The agent may produce evidence, but it cannot approve its own authority, change gate definitions in
a run, reinterpret stale evidence as current, or claim completion while an enforced gate or artifact
is missing.

Memory Cloud is the persistent store for episodic lessons and operational context. The compiled
governance plan remains the normative project law.

Before handing off a change, run:

```bash
npm run governance:check
npm run check
npm run build
```
