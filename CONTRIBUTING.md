# Contributing to OverlayKit

Every contribution is evaluated against the current governance plan.

1. Create a branch.
2. Add a new typed change contract under `.overlaykit/governance/changes/`.
3. Reference the accepted ADRs that authorize the change.
4. Keep claims and unknowns explicit.
5. Implement only the declared scope.
6. Run `npm run governance:check`, `npm run check`, and `npm run build`.
7. Open a pull request using the repository template.

Accepted ADR and merged change-contract files are immutable. Create a new ID when changing a prior
decision or completed change.

Changes to the governance host, schemas, profile, mechanism registry, workflows, or ownership rules
are governance changes. They require an explicit governance change contract and a new ADR when they
alter the law.
