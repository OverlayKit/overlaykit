import { canonicalJson } from './canonical.js';
import type {
  EnforcementMechanism,
  GateOutcome,
  GovernanceManifest,
  GovernanceObservation,
  GovernancePlan,
  GovernanceRun,
  ObservedGate,
  ObservedPlan,
} from './types.js';

function invalid(
  plan: GovernancePlan,
  run: GovernanceRun,
  reason: string,
): GovernanceObservation {
  return { state: 'invalid', plan, run, reason, ready: false, blockers: [reason] };
}

function isValidDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function producerMatchesMechanism(
  run: GovernanceRun,
  mechanism: EnforcementMechanism,
): boolean {
  if (mechanism.kind === 'local-command') {
    return run.source === 'local' && run.producer.kind === 'local-cli';
  }

  if (mechanism.kind === 'github-actions-job') {
    const [workflowPath] = mechanism.locator.split('#', 1);
    return (
      run.source === 'ci' &&
      run.producer.kind === 'github-actions' &&
      run.producer.id === workflowPath &&
      run.producer.commit !== null
    );
  }

  return false;
}

export function observeRun(
  plan: GovernancePlan,
  manifest: GovernanceManifest,
  run: GovernanceRun | null,
): GovernanceObservation {
  if (run === null) {
    return {
      state: 'never-observed',
      plan,
      run: null,
      reason: null,
      ready: false,
      blockers: ['No governance run has observed this plan.'],
    };
  }

  if (
    run.profileHash !== plan.profileHash ||
    run.planHash !== plan.planHash ||
    run.manifestHash !== manifest.contentHash
  ) {
    return {
      state: 'stale',
      plan,
      run,
      reason: 'The run observed a different profileHash, planHash, or manifestHash.',
      ready: false,
      blockers: ['Evidence is stale for the current plan.'],
    };
  }

  if (run.runId === '') {
    return invalid(plan, run, 'The runId is empty.');
  }

  if (!isValidDate(run.startedAt) || !isValidDate(run.finishedAt)) {
    return invalid(plan, run, 'The run contains an invalid timestamp.');
  }

  if (Date.parse(run.finishedAt) < Date.parse(run.startedAt)) {
    return invalid(plan, run, 'The run finished before it started.');
  }

  const actor = plan.actors.find((candidate) => candidate.id === run.invokedBy.id);
  if (!actor) {
    return invalid(plan, run, `Unknown invoker ${run.invokedBy.id}.`);
  }

  if (
    actor.kind !== run.invokedBy.kind ||
    actor.principal !== run.invokedBy.principal
  ) {
    return invalid(plan, run, `Invoker identity does not match actor ${actor.id}.`);
  }

  if (canonicalJson(run.assumptions) !== canonicalJson(plan.assumptions)) {
    return invalid(plan, run, 'The run assumptions differ from the compiled plan.');
  }

  const gateIndex = new Map(plan.gates.map((gate) => [gate.id, gate]));
  const mechanismIndex = new Map(
    plan.mechanisms.map((mechanism) => [mechanism.id, mechanism]),
  );
  const outcomes = new Map<string, GateOutcome>();
  const artifactIndex = new Map(plan.artifacts.map((artifact) => [artifact.id, artifact]));
  const artifactEvidence = new Map(run.artifacts.map((artifact) => [artifact.artifact, artifact]));

  if (artifactEvidence.size !== run.artifacts.length) {
    return invalid(plan, run, 'The run contains duplicate artifact evidence.');
  }

  for (const artifact of run.artifacts) {
    if (!artifactIndex.has(artifact.artifact)) {
      return invalid(plan, run, `Unknown artifact ${artifact.artifact}.`);
    }
  }

  for (const record of run.outcomes) {
    if (outcomes.has(record.gate)) {
      return invalid(plan, run, `Duplicate outcome for gate ${record.gate}.`);
    }

    const gate = gateIndex.get(record.gate);
    if (!gate) {
      return invalid(plan, run, `Unknown gate ${record.gate}.`);
    }

    if (record.outcome === 'passed' && !record.producerRef) {
      return invalid(plan, run, `Passed gate ${record.gate} has no producerRef.`);
    }

    if (record.outcome === 'waived' && !record.justification) {
      return invalid(plan, run, `Waived gate ${record.gate} has no justification.`);
    }

    if (record.boundTo !== null && record.boundTo !== gate.boundTo) {
      return invalid(plan, run, `Run redefines boundTo for gate ${record.gate}.`);
    }

    if (record.outcome === 'passed' && gate.boundTo !== null) {
      const mechanism = mechanismIndex.get(gate.boundTo);
      if (!mechanism || !producerMatchesMechanism(run, mechanism)) {
        return invalid(
          plan,
          run,
          `Producer cannot prove gate ${record.gate} through ${gate.boundTo}.`,
        );
      }
    }

    outcomes.set(record.gate, record.outcome);
  }

  const observedGates: ObservedGate[] = plan.gates.map((gate) => ({
    ...gate,
    outcome: outcomes.get(gate.id) ?? 'pending',
  }));
  const observedArtifacts = plan.artifacts.map((artifact) => {
    const evidence = artifactEvidence.get(artifact.id);
    return {
      ...artifact,
      state: evidence ? ('present' as const) : ('missing' as const),
      producerRef: evidence?.producerRef ?? null,
      contentHash: evidence?.contentHash ?? null,
    };
  });
  const observedPlan: ObservedPlan = {
    ...plan,
    gates: observedGates,
    artifacts: observedArtifacts,
  };
  const blockers = [
    ...observedGates
      .filter((gate) => gate.tier === 'enforced' && gate.outcome !== 'passed')
      .map((gate) => `Gate ${gate.id} is ${gate.outcome}.`),
    ...observedArtifacts
      .filter((artifact) => artifact.tier === 'enforced' && artifact.state !== 'present')
      .map((artifact) => `Artifact ${artifact.id} is missing.`),
  ];

  return {
    state: 'current',
    plan: observedPlan,
    run,
    reason: null,
    ready: blockers.length === 0,
    blockers,
  };
}
