# Contributing to OverlayKit

Every contribution is evaluated against the current governance plan.

1. Create a branch.
2. Add a new typed change contract under `.overlaykit/governance/changes/`.
3. Reference the accepted ADRs that authorize the change.
4. Reference the active `SPEC-*` records that authorize non-governance work.
5. Keep claims and unknowns explicit.
6. Implement only the declared scope and observable acceptance criteria.
7. Run `npm run governance:check`, `npm run check`, and `npm run build`.
8. Open a pull request using the repository template.

Accepted ADR, accepted product specification, and merged change-contract files are immutable. Create
a new ID and explicit supersession when changing prior law, requirements, or completed changes.

Changes to the governance host, schemas, profile, mechanism registry, workflows, or ownership rules
are governance changes. They require an explicit governance change contract and a new ADR when they
alter the law.

Unless explicitly stated otherwise, contributions intentionally submitted for inclusion in
OverlayKit are provided under the Apache License 2.0, as described in section 5 of [LICENSE](LICENSE).
