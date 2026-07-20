import { canonicalHash, canonicalJson, compareById } from './canonical.js';
import {
  MANIFEST_SCHEMA_VERSION,
  type GovernanceManifest,
  type GovernancePlan,
  type LoadedContract,
} from './types.js';

function sortedRecord(entries: Array<readonly [string, string]>): Record<string, string> {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

export function buildManifest(
  contract: LoadedContract,
  plan: GovernancePlan,
): GovernanceManifest {
  const decisions = sortedRecord(
    [...contract.decisions]
      .sort((left, right) => compareById(left.decision, right.decision))
      .map((record) => [record.decision.id, record.contentHash] as const),
  );
  const schemas = sortedRecord(Object.entries(contract.schemas));
  const changes = sortedRecord(
    contract.changes.map((record) => [record.change.id, record.contentHash] as const),
  );

  const body = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    decisions,
    changes,
    schemas,
    profileHash: plan.profileHash,
    mechanismsHash: plan.mechanismsHash,
    planHash: plan.planHash,
  };

  return {
    ...body,
    contentHash: canonicalHash(body),
  };
}

export function verifyManifestIntegrity(
  manifest: GovernanceManifest,
  contract: LoadedContract,
  plan: GovernancePlan,
): boolean {
  const expected = buildManifest(contract, plan);
  return canonicalJson(expected) === canonicalJson(manifest);
}

export function immutabilityViolations(
  base: GovernanceManifest,
  current: GovernanceManifest,
): string[] {
  const decisions = Object.entries(base.decisions)
    .filter(([id, hash]) => current.decisions[id] !== hash)
    .map(([id]) => `decision:${id}`);
  const changes = Object.entries(base.changes ?? {})
    .filter(([id, hash]) => current.changes[id] !== hash)
    .map(([id]) => `change:${id}`);

  return [...decisions, ...changes].sort();
}
