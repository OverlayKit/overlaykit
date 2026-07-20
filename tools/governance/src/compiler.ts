import { canonicalHash, compareById } from './canonical.js';
import { invariant } from './errors.js';
import {
  ENGINE_VERSION,
  PLAN_SCHEMA_VERSION,
  type CompiledArtifact,
  type CompiledDecision,
  type CompiledGate,
  type DecisionRecord,
  type GovernancePlan,
  type GovernanceProfile,
  type GovernanceRule,
  type LoadedContract,
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

function compileProfileHash(
  contract: LoadedContract,
  selectedRecords: DecisionRecord[],
): string {
  const decisionHashes = Object.fromEntries(
    selectedRecords
      .map((record) => [record.decision.id, record.contentHash] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );

  return canonicalHash({
    profile: {
      ...contract.profile,
      decisionIds: [...contract.profile.decisionIds].sort(),
      gates: [...contract.profile.gates].sort(compareById),
      artifacts: [...contract.profile.artifacts].sort(compareById),
      actors: [...contract.profile.actors].sort(compareById),
      assumptions: [...contract.profile.assumptions].sort(compareById),
    },
    decisionHashes,
    mechanismsHash: contract.mechanismsHash,
    schemasHash: contract.schemasHash,
  });
}

export function compileGovernance(contract: LoadedContract): GovernancePlan {
  const { decisionsById, supersededBy } = validateContract(
    contract.decisions,
    contract.profile,
    contract.mechanisms,
    contract.changes,
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

  const profileHash = compileProfileHash(contract, lineageRecords);
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
    rules,
    gates: gates.map(({ outcome: _outcome, ...gate }) => gate),
    artifacts,
    actors: [...contract.profile.actors].sort(compareById),
    assumptions: [...contract.profile.assumptions].sort(compareById),
  };

  return {
    ...planWithoutHash,
    gates,
    planHash: canonicalHash(planWithoutHash),
  };
}
