import { canonicalHash, compareById } from './canonical.js';
import { invariant } from './errors.js';
import {
  ENGINE_VERSION,
  PLAN_SCHEMA_VERSION,
  type CompiledArtifact,
  type CompiledDecision,
  type CompiledGate,
  type CompiledSpecification,
  type DecisionRecord,
  type GovernancePlan,
  type GovernanceProfile,
  type GovernanceRule,
  type LoadedContract,
  type SpecificationRecord,
} from './types.js';
import { validateContract } from './validator.js';

function collectLineage(
  profile: GovernanceProfile,
  decisionsById: Map<string, DecisionRecord>,
): Set<string> {
  const lineage = new Set<string>();

  for (const currentId of profile.decisionIds) {
    let id: string | null = currentId;

    while (id !== null) {
      if (lineage.has(id)) {
        break;
      }

      lineage.add(id);
      const record = decisionsById.get(id);
      invariant(record !== undefined, 'DECISION_NOT_FOUND', `Missing lineage decision ${id}`);
      id = record.decision.supersedes;
    }
  }

  return lineage;
}

function collectSpecificationLineage(
  profile: GovernanceProfile,
  specificationsById: Map<string, SpecificationRecord>,
): Set<string> {
  const lineage = new Set<string>();

  for (const currentId of profile.specificationIds ?? []) {
    let id: string | null = currentId;

    while (id !== null) {
      if (lineage.has(id)) {
        break;
      }

      lineage.add(id);
      const record = specificationsById.get(id);
      invariant(
        record !== undefined,
        'SPECIFICATION_NOT_FOUND',
        `Missing specification lineage ${id}`,
      );
      id = record.specification.supersedes;
    }
  }

  return lineage;
}

function compileProfileHash(
  contract: LoadedContract,
  selectedDecisions: DecisionRecord[],
  selectedSpecifications: SpecificationRecord[],
): string {
  const decisionHashes = Object.fromEntries(
    selectedDecisions
      .map((record) => [record.decision.id, record.contentHash] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const specificationHashes = Object.fromEntries(
    selectedSpecifications
      .map((record) => [record.specification.id, record.contentHash] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );

  return canonicalHash({
    profile: {
      ...contract.profile,
      decisionIds: [...contract.profile.decisionIds].sort(),
      specificationIds: [...(contract.profile.specificationIds ?? [])].sort(),
      gates: [...contract.profile.gates].sort(compareById),
      artifacts: [...contract.profile.artifacts].sort(compareById),
      actors: [...contract.profile.actors].sort(compareById),
      assumptions: [...contract.profile.assumptions].sort(compareById),
      trustAnchors: [...contract.profile.trustAnchors].sort(compareById),
    },
    decisionHashes,
    specificationHashes,
    mechanismsHash: contract.mechanismsHash,
    schemasHash: contract.schemasHash,
  });
}

export function compileGovernance(contract: LoadedContract): GovernancePlan {
  const {
    decisionsById,
    specificationsById,
    supersededBy,
    specificationSupersededBy,
  } = validateContract(
    contract.decisions,
    contract.profile,
    contract.mechanisms,
    contract.changes,
    contract.specifications,
  );

  const lineageIds = collectLineage(contract.profile, decisionsById);
  const lineageRecords = [...lineageIds]
    .map((id) => decisionsById.get(id))
    .filter((record): record is DecisionRecord => record !== undefined)
    .sort((left, right) => left.decision.id.localeCompare(right.decision.id));

  const decisions: CompiledDecision[] = lineageRecords.map((record) => {
    const successor = supersededBy.get(record.decision.id) ?? null;
    return {
      id: record.decision.id,
      title: record.decision.title,
      declaredStatus: record.decision.status,
      effectiveStatus: successor === null ? record.decision.status : 'superseded',
      supersededBy: successor,
      contentHash: record.contentHash,
    };
  });
  const specificationLineageIds = collectSpecificationLineage(
    contract.profile,
    specificationsById,
  );
  const specificationLineageRecords = [...specificationLineageIds]
    .map((id) => specificationsById.get(id))
    .filter((record): record is SpecificationRecord => record !== undefined)
    .sort((left, right) =>
      left.specification.id.localeCompare(right.specification.id),
    );
  const specifications: CompiledSpecification[] = specificationLineageRecords.map(
    (record) => {
      const specification = record.specification;
      const successor = specificationSupersededBy.get(specification.id) ?? null;
      return {
        id: specification.id,
        title: specification.title,
        declaredStatus: specification.status,
        effectiveStatus: successor === null ? specification.status : 'superseded',
        supersededBy: successor,
        contentHash: record.contentHash,
        requirementIds: specification.requirements.map(({ id }) => id).sort(),
        userStoryIds: specification.userStories.map(({ id }) => id).sort(),
        workflowIds: specification.workflows.map(({ id }) => id).sort(),
      };
    },
  );

  const rules: GovernanceRule[] = [];
  const gates: CompiledGate[] = contract.profile.gates.map((gate) => ({
    ...gate,
    sourceDecision: null,
    outcome: null,
  }));
  const artifacts: CompiledArtifact[] = contract.profile.artifacts.map((artifact) => ({
    ...artifact,
    sourceDecision: null,
  }));

  for (const decisionId of [...contract.profile.decisionIds].sort()) {
    const record = decisionsById.get(decisionId);
    invariant(record !== undefined, 'DECISION_NOT_FOUND', `Missing decision ${decisionId}`);

    for (const policy of record.decision.policies) {
      if (policy.kind === 'rule') {
        rules.push({ ...policy, sourceDecision: decisionId });
      }

      if (policy.kind === 'gate') {
        gates.push({ ...policy, sourceDecision: decisionId, outcome: null });
      }

      if (policy.kind === 'artifact') {
        artifacts.push({ ...policy, sourceDecision: decisionId });
      }
    }
  }

  rules.sort(compareById);
  gates.sort(compareById);
  artifacts.sort(compareById);

  const profileHash = compileProfileHash(
    contract,
    lineageRecords,
    specificationLineageRecords,
  );
  const planWithoutHash = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    profileName: contract.profile.name,
    profileVersion: contract.profile.version,
    profileHash,
    mechanismsHash: contract.mechanismsHash,
    schemasHash: contract.schemasHash,
    mechanisms: [...contract.mechanisms.mechanisms].sort(compareById),
    decisions,
    specifications,
    rules,
    gates: gates.map(({ outcome: _outcome, ...gate }) => gate),
    artifacts,
    actors: [...contract.profile.actors].sort(compareById),
    assumptions: [...contract.profile.assumptions].sort(compareById),
    trustAnchors: [...contract.profile.trustAnchors].sort(compareById),
  };

  return {
    ...planWithoutHash,
    gates,
    planHash: canonicalHash(planWithoutHash),
  };
}
