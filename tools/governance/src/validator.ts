import { GovernanceError, invariant } from './errors.js';
import type {
  ChangeRecord,
  DecisionRecord,
  EnforcementMechanism,
  GovernanceDecision,
  GovernanceProfile,
  MechanismRegistry,
  ProductSpecification,
  RequiredArtifact,
  SpecificationRecord,
} from './types.js';

export interface ValidatedContract {
  decisionsById: Map<string, DecisionRecord>;
  specificationsById: Map<string, SpecificationRecord>;
  mechanismsById: Map<string, EnforcementMechanism>;
  supersededBy: Map<string, string>;
  specificationSupersededBy: Map<string, string>;
}

function indexUnique<T extends { id: string }>(
  values: T[],
  code: string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();

  for (const value of values) {
    invariant(!result.has(value.id), code, `Duplicate ${label} id: ${value.id}`);
    result.set(value.id, value);
  }

  return result;
}

function assertNoSupersessionCycles(
  decisionsById: Map<string, DecisionRecord>,
): void {
  const globallyVisited = new Set<string>();

  for (const start of decisionsById.values()) {
    if (globallyVisited.has(start.decision.id)) {
      continue;
    }

    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let current: GovernanceDecision | undefined = start.decision;

    while (current) {
      const repeatedAt = pathIndex.get(current.id);
      if (repeatedAt !== undefined) {
        const cycle = [...path.slice(repeatedAt), current.id];
        throw new GovernanceError(
          'SUPERSESSION_CYCLE',
          `Supersession cycle: ${cycle.join(' -> ')}`,
        );
      }

      if (globallyVisited.has(current.id)) {
        break;
      }

      pathIndex.set(current.id, path.length);
      path.push(current.id);

      if (current.supersedes === null) {
        break;
      }

      current = decisionsById.get(current.supersedes)?.decision;
    }

    for (const id of path) {
      globallyVisited.add(id);
    }
  }
}

function deriveSupersededBy(decisions: DecisionRecord[]): Map<string, string> {
  const supersededBy = new Map<string, string>();

  for (const record of decisions) {
    const decision = record.decision;
    if (decision.status !== 'accepted' || decision.supersedes === null) {
      continue;
    }

    invariant(
      !supersededBy.has(decision.supersedes),
      'SUPERSESSION_AMBIGUOUS',
      `${decision.supersedes} is superseded by more than one accepted decision`,
    );
    supersededBy.set(decision.supersedes, decision.id);
  }

  return supersededBy;
}

function assertNoSpecificationSupersessionCycles(
  specificationsById: Map<string, SpecificationRecord>,
): void {
  for (const start of specificationsById.values()) {
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let current: ProductSpecification | undefined = start.specification;

    while (current) {
      const repeatedAt = pathIndex.get(current.id);
      if (repeatedAt !== undefined) {
        const cycle = [...path.slice(repeatedAt), current.id];
        throw new GovernanceError(
          'SPECIFICATION_SUPERSESSION_CYCLE',
          `Specification supersession cycle: ${cycle.join(' -> ')}`,
        );
      }

      pathIndex.set(current.id, path.length);
      path.push(current.id);
      current =
        current.supersedes === null
          ? undefined
          : specificationsById.get(current.supersedes)?.specification;
    }
  }
}

function deriveSpecificationSupersededBy(
  specifications: SpecificationRecord[],
): Map<string, string> {
  const supersededBy = new Map<string, string>();

  for (const record of specifications) {
    const specification = record.specification;
    if (specification.status !== 'accepted' || specification.supersedes === null) {
      continue;
    }

    invariant(
      !supersededBy.has(specification.supersedes),
      'SPECIFICATION_SUPERSESSION_AMBIGUOUS',
      `${specification.supersedes} is superseded by more than one accepted specification`,
    );
    supersededBy.set(specification.supersedes, specification.id);
  }

  return supersededBy;
}

function assertSpecificationSemantics(specification: ProductSpecification): void {
  const actors = indexUnique(specification.actors, 'SPECIFICATION_ACTOR_DUPLICATE', 'actor');
  indexUnique(specification.terms, 'SPECIFICATION_TERM_DUPLICATE', 'term');
  const requirements = indexUnique(
    specification.requirements,
    'SPECIFICATION_REQUIREMENT_DUPLICATE',
    'requirement',
  );
  indexUnique(specification.userStories, 'SPECIFICATION_STORY_DUPLICATE', 'user story');
  indexUnique(specification.workflows, 'SPECIFICATION_WORKFLOW_DUPLICATE', 'workflow');
  const acceptanceIds = new Set<string>();

  for (const story of specification.userStories) {
    invariant(
      actors.has(story.actor),
      'SPECIFICATION_ACTOR_MISSING',
      `${story.id} references missing actor ${story.actor}`,
    );

    for (const criterion of story.acceptanceCriteria) {
      invariant(
        !acceptanceIds.has(criterion.id),
        'SPECIFICATION_CRITERION_DUPLICATE',
        `Duplicate acceptance criterion id: ${criterion.id}`,
      );
      acceptanceIds.add(criterion.id);
    }
  }

  for (const workflow of specification.workflows) {
    for (const actor of workflow.actors) {
      invariant(
        actors.has(actor),
        'SPECIFICATION_ACTOR_MISSING',
        `${workflow.id} references missing actor ${actor}`,
      );
    }

    for (const requirement of workflow.invariants) {
      invariant(
        requirements.has(requirement),
        'SPECIFICATION_REQUIREMENT_MISSING',
        `${workflow.id} references missing requirement ${requirement}`,
      );
    }
  }
}

function assertEnforcementBound(
  id: string,
  tier: string,
  boundTo: string | null,
  mechanismsById: Map<string, EnforcementMechanism>,
): void {
  if (tier !== 'enforced') {
    return;
  }

  invariant(
    boundTo !== null,
    'ENFORCEMENT_UNPROVEN',
    `Enforced contract item ${id} has no boundTo mechanism`,
  );

  const mechanism = mechanismsById.get(boundTo);
  invariant(
    mechanism !== undefined && mechanism.enforcementCapable,
    'ENFORCEMENT_UNPROVEN',
    `Enforced contract item ${id} is bound to an unknown or incapable mechanism: ${boundTo}`,
  );
}

function assertArtifactEnforcement(
  artifact: RequiredArtifact,
  mechanismsById: Map<string, EnforcementMechanism>,
): void {
  assertEnforcementBound(
    artifact.id,
    artifact.tier,
    artifact.producedBy,
    mechanismsById,
  );
}

export function validateContract(
  decisions: DecisionRecord[],
  profile: GovernanceProfile,
  registry: MechanismRegistry,
  changes: ChangeRecord[] = [],
  specifications: SpecificationRecord[] = [],
): ValidatedContract {
  const decisionsById = indexUnique(
    decisions.map((record) => ({ ...record, id: record.decision.id })),
    'DECISION_DUPLICATE',
    'decision',
  );

  for (const record of decisions) {
    const { id, supersedes } = record.decision;
    if (supersedes === null) {
      continue;
    }

    invariant(
      supersedes !== id,
      'SUPERSESSION_CYCLE',
      `${id} cannot supersede itself`,
    );
    invariant(
      decisionsById.has(supersedes),
      'DECISION_NOT_FOUND',
      `${id} supersedes missing decision ${supersedes}`,
    );
  }

  assertNoSupersessionCycles(decisionsById);
  const supersededBy = deriveSupersededBy(decisions);
  const specificationsById = indexUnique(
    specifications.map((record) => ({ ...record, id: record.specification.id })),
    'SPECIFICATION_DUPLICATE',
    'specification',
  );

  for (const record of specifications) {
    const { id, supersedes } = record.specification;
    assertSpecificationSemantics(record.specification);
    if (supersedes === null) {
      continue;
    }
    invariant(
      supersedes !== id,
      'SPECIFICATION_SUPERSESSION_CYCLE',
      `${id} cannot supersede itself`,
    );
    invariant(
      specificationsById.has(supersedes),
      'SPECIFICATION_NOT_FOUND',
      `${id} supersedes missing specification ${supersedes}`,
    );
  }

  assertNoSpecificationSupersessionCycles(specificationsById);
  const specificationSupersededBy = deriveSpecificationSupersededBy(specifications);
  const mechanismsById = indexUnique(
    registry.mechanisms,
    'MECHANISM_DUPLICATE',
    'mechanism',
  );
  const actorsById = indexUnique(profile.actors, 'IDENTITY_DUPLICATE', 'actor');
  indexUnique(profile.trustAnchors, 'TRUST_ANCHOR_DUPLICATE', 'trust anchor');
  const changesById = indexUnique(
    changes.map((record) => ({ ...record, id: record.change.id })),
    'CHANGE_DUPLICATE',
    'change',
  );

  for (const record of changesById.values()) {
    for (const decisionId of record.change.decisions) {
      invariant(
        decisionsById.has(decisionId),
        'DECISION_NOT_FOUND',
        `${record.change.id} references missing decision ${decisionId}`,
      );
    }

    const specificationIds = record.change.specifications ?? [];
    if (
      record.change.schemaVersion === 'overlaykit-governance-change/v2' &&
      record.change.changeClass !== 'governance'
    ) {
      invariant(
        specificationIds.length > 0,
        'CHANGE_SPECIFICATION_MISSING',
        `${record.change.id} must reference at least one product specification`,
      );
    }

    for (const specificationId of specificationIds) {
      invariant(
        specificationsById.has(specificationId),
        'SPECIFICATION_NOT_FOUND',
        `${record.change.id} references missing specification ${specificationId}`,
      );
    }
  }

  invariant(
    new Set(profile.decisionIds).size === profile.decisionIds.length,
    'PROFILE_INVALID',
    'Profile decisionIds must be unique',
  );

  for (const id of profile.decisionIds) {
    const record = decisionsById.get(id);
    invariant(record !== undefined, 'DECISION_NOT_FOUND', `Profile references missing decision ${id}`);
    invariant(
      record.decision.status === 'accepted',
      'DECISION_INACTIVE',
      `Profile decision ${id} is ${record.decision.status}, not accepted`,
    );
    invariant(
      !supersededBy.has(id),
      'DECISION_INACTIVE',
      `Profile decision ${id} is superseded by ${supersededBy.get(id)}`,
    );
  }

  const activeSpecificationIds = profile.specificationIds ?? [];
  invariant(
    new Set(activeSpecificationIds).size === activeSpecificationIds.length,
    'PROFILE_INVALID',
    'Profile specificationIds must be unique',
  );

  for (const id of activeSpecificationIds) {
    const record = specificationsById.get(id);
    invariant(
      record !== undefined,
      'SPECIFICATION_NOT_FOUND',
      `Profile references missing specification ${id}`,
    );
    invariant(
      record.specification.status === 'accepted',
      'SPECIFICATION_INACTIVE',
      `Profile specification ${id} is ${record.specification.status}, not accepted`,
    );
    invariant(
      !specificationSupersededBy.has(id),
      'SPECIFICATION_INACTIVE',
      `Profile specification ${id} is superseded by ${specificationSupersededBy.get(id)}`,
    );
  }

  for (const actor of profile.actors) {
    if (actor.kind === 'agent') {
      invariant(
        actor.principal !== null && actor.principal !== '',
        'IDENTITY_UNDELEGATED',
        `Agent ${actor.id} must name a human principal`,
      );
      invariant(
        actorsById.get(actor.principal)?.kind === 'human',
        'IDENTITY_UNDELEGATED',
        `Agent ${actor.id} principal ${actor.principal} is not a registered human actor`,
      );
    }
  }

  const ruleIds = new Set<string>();
  const gateIds = new Set<string>();
  const artifactIds = new Set<string>();

  for (const gate of profile.gates) {
    invariant(!gateIds.has(gate.id), 'GATE_DUPLICATE', `Duplicate gate id: ${gate.id}`);
    gateIds.add(gate.id);
    assertEnforcementBound(gate.id, gate.tier, gate.boundTo, mechanismsById);
  }

  for (const artifact of profile.artifacts) {
    invariant(
      !artifactIds.has(artifact.id),
      'ARTIFACT_DUPLICATE',
      `Duplicate artifact id: ${artifact.id}`,
    );
    artifactIds.add(artifact.id);
    assertArtifactEnforcement(artifact, mechanismsById);
  }

  for (const decisionId of profile.decisionIds) {
    const record = decisionsById.get(decisionId);
    invariant(record !== undefined, 'DECISION_NOT_FOUND', `Missing decision ${decisionId}`);

    for (const policy of record.decision.policies) {
      if (policy.kind === 'rule') {
        invariant(
          !ruleIds.has(policy.id),
          'RULE_DUPLICATE',
          `Duplicate rule id: ${policy.id}`,
        );
        ruleIds.add(policy.id);
      }

      if (policy.kind === 'gate') {
        invariant(
          !gateIds.has(policy.id),
          'GATE_DUPLICATE',
          `Duplicate gate id: ${policy.id}`,
        );
        gateIds.add(policy.id);
        assertEnforcementBound(policy.id, policy.tier, policy.boundTo, mechanismsById);
      }

      if (policy.kind === 'artifact') {
        invariant(
          !artifactIds.has(policy.id),
          'ARTIFACT_DUPLICATE',
          `Duplicate artifact id: ${policy.id}`,
        );
        artifactIds.add(policy.id);
        assertArtifactEnforcement(policy, mechanismsById);
      }
    }
  }

  return {
    decisionsById,
    specificationsById,
    mechanismsById,
    supersededBy,
    specificationSupersededBy,
  };
}
