import { describe, expect, it } from 'vitest';
import { compileGovernance } from '../src/compiler.js';
import { GovernanceError } from '../src/errors.js';
import { buildManifest, immutabilityViolations } from '../src/manifest.js';
import { observeRun } from '../src/projector.js';
import {
  ENGINE_VERSION,
  RUN_SCHEMA_VERSION,
  type DecisionRecord,
  type GovernanceDecision,
  type GovernanceManifest,
  type GovernanceProfile,
  type GovernanceRun,
  type LoadedContract,
  type MechanismRegistry,
} from '../src/types.js';

function decision(
  id: string,
  policies: GovernanceDecision['policies'] = [],
  supersedes: string | null = null,
): GovernanceDecision {
  return {
    schemaVersion: 'overlaykit-governance-decision/v1',
    id,
    title: `Decision ${id}`,
    status: 'accepted',
    date: '2026-07-20',
    supersedes,
    governs: ['quality'],
    context: 'Context',
    decision: 'Decision',
    consequences: ['Consequence'],
    policies,
  };
}

function record(value: GovernanceDecision): DecisionRecord {
  return {
    decision: value,
    contentHash: value.id.padEnd(64, '0').slice(0, 64),
    path: `.overlaykit/governance/decisions/${value.id}.json`,
  };
}

function profile(decisionIds: string[]): GovernanceProfile {
  return {
    schemaVersion: 'overlaykit-governance-profile/v1',
    name: 'test',
    version: '1.0.0',
    decisionIds,
    gates: [],
    artifacts: [],
    actors: [
      {
        kind: 'human',
        id: '@owner',
        principal: null,
        roles: ['owner'],
      },
      {
        kind: 'agent',
        id: 'codex',
        principal: '@owner',
        roles: ['author'],
      },
    ],
    assumptions: [],
    trustAnchors: [],
  };
}

const mechanisms: MechanismRegistry = {
  schemaVersion: 'overlaykit-governance-mechanisms/v1',
  mechanisms: [
    {
      id: 'ci:test',
      kind: 'local-command',
      locator: 'package.json#scripts.test',
      subject: 'tests',
      enforcementCapable: true,
      expectedCommand: 'vitest run',
    },
  ],
};

function contract(
  decisions: DecisionRecord[],
  activeIds: string[],
  registry = mechanisms,
): LoadedContract {
  return {
    decisions,
    changes: [],
    profile: profile(activeIds),
    mechanisms: registry,
    schemas: { 'test.schema.json': 'a'.repeat(64) },
    schemasHash: 'b'.repeat(64),
    mechanismsHash: 'c'.repeat(64),
  };
}

function currentRun(
  plan: ReturnType<typeof compileGovernance>,
  manifest: GovernanceManifest,
  overrides: Partial<GovernanceRun> = {},
): GovernanceRun {
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: 'run-1',
    profileHash: plan.profileHash,
    planHash: plan.planHash,
    manifestHash: manifest.contentHash,
    invokedBy: { kind: 'agent', id: 'codex', principal: '@owner' },
    producer: {
      kind: 'local-cli',
      id: 'vitest',
      version: '1',
      commit: 'a'.repeat(40),
    },
    subject: {
      repository: 'OverlayKit/overlaykit',
      commit: 'a'.repeat(40),
      ref: 'refs/heads/test',
      event: 'local',
      pullRequest: null,
    },
    source: 'local',
    startedAt: '2026-07-20T00:00:00.000Z',
    finishedAt: '2026-07-20T00:00:01.000Z',
    assumptions: plan.assumptions,
    outcomes: plan.gates.map((gate) => ({
      gate: gate.id,
      outcome: 'passed',
      producerRef: 'test://evidence',
      justification: null,
      boundTo: gate.boundTo,
    })),
    artifacts: plan.artifacts.map((artifact) => ({
      artifact: artifact.id,
      producerRef: 'test://artifact',
      contentHash: null,
    })),
    ...overrides,
  };
}

describe('deterministic compiler', () => {
  it('produces the same planHash regardless of corpus and profile ordering', () => {
    const first = record(
      decision('ADR-0001', [
        { kind: 'rule', id: 'rule-b', statement: 'B' },
        { kind: 'rule', id: 'rule-a', statement: 'A' },
      ]),
    );
    const second = record(decision('ADR-0002'));

    const left = compileGovernance(contract([first, second], ['ADR-0002', 'ADR-0001']));
    const right = compileGovernance(contract([second, first], ['ADR-0001', 'ADR-0002']));

    expect(left.planHash).toBe(right.planHash);
    expect(left.engineVersion).toBe(ENGINE_VERSION);
    expect(left.rules.map((rule) => rule.id)).toEqual(['rule-a', 'rule-b']);
  });

  it('fails closed when enforced is not bound to a real mechanism', () => {
    const item = record(
      decision('ADR-0001', [
        {
          kind: 'gate',
          id: 'tests',
          description: 'Tests pass',
          tier: 'enforced',
          boundTo: 'ci:missing',
        },
      ]),
    );

    expect(() => compileGovernance(contract([item], ['ADR-0001']))).toThrowError(
      GovernanceError,
    );
  });

  it('fails when an agent principal is not a registered human actor', () => {
    const item = record(decision('ADR-0001'));
    const invalidContract = contract([item], ['ADR-0001']);
    invalidContract.profile.actors[1] = {
      kind: 'agent',
      id: 'codex',
      principal: '@missing',
      roles: ['author'],
    };

    expect(() => compileGovernance(invalidContract)).toThrowError(GovernanceError);
  });

  it('derives supersession without mutating the accepted predecessor', () => {
    const old = record(decision('ADR-0001'));
    const next = record(decision('ADR-0002', [], 'ADR-0001'));
    const plan = compileGovernance(contract([old, next], ['ADR-0002']));

    expect(plan.decisions).toEqual([
      expect.objectContaining({
        id: 'ADR-0001',
        declaredStatus: 'accepted',
        effectiveStatus: 'superseded',
        supersededBy: 'ADR-0002',
      }),
      expect.objectContaining({
        id: 'ADR-0002',
        declaredStatus: 'accepted',
        effectiveStatus: 'accepted',
      }),
    ]);
  });
});

describe('manifest', () => {
  it('allows additions but detects changed or removed historical records', () => {
    const first = record(decision('ADR-0001'));
    const baseContract = contract([first], ['ADR-0001']);
    const basePlan = compileGovernance(baseContract);
    const base = buildManifest(baseContract, basePlan);

    const added = record(decision('ADR-0002'));
    const currentContract = contract([first, added], ['ADR-0001']);
    const currentPlan = compileGovernance(currentContract);
    const current = buildManifest(currentContract, currentPlan);

    expect(immutabilityViolations(base, current)).toEqual([]);

    current.decisions['ADR-0001'] = 'f'.repeat(64);
    expect(immutabilityViolations(base, current)).toEqual(['decision:ADR-0001']);
  });
});

describe('evidence projection', () => {
  const item = record(
    decision('ADR-0001', [
      {
        kind: 'gate',
        id: 'tests',
        description: 'Tests pass',
        tier: 'enforced',
        boundTo: 'ci:test',
      },
      {
        kind: 'artifact',
        id: 'report',
        description: 'Test report',
        tier: 'enforced',
        producedBy: 'ci:test',
      },
    ]),
  );
  const evidenceContract = contract([item], ['ADR-0001']);
  const plan = compileGovernance(evidenceContract);
  const manifest = buildManifest(evidenceContract, plan);

  it('is ready only with current passing evidence and required artifacts', () => {
    const run = currentRun(plan, manifest);
    const observation = observeRun(plan, manifest, run, run.subject);
    expect(observation.state).toBe('current');
    expect(observation.ready).toBe(true);
    expect(observation.blockers).toEqual([]);
  });

  it('marks evidence for a different plan as stale', () => {
    const run = currentRun(plan, manifest, { planHash: 'f'.repeat(64) });
    const observation = observeRun(plan, manifest, run, run.subject);
    expect(observation.state).toBe('stale');
    expect(observation.ready).toBe(false);
  });

  it('rejects evidence that redefines a gate binding', () => {
    const run = currentRun(plan, manifest);
    run.outcomes[0] = { ...run.outcomes[0]!, boundTo: 'ci:other' };
    const observation = observeRun(plan, manifest, run, run.subject);
    expect(observation.state).toBe('invalid');
    expect(observation.reason).toContain('redefines boundTo');
  });

  it('keeps missing evidence pending instead of fabricating success', () => {
    const run = currentRun(plan, manifest, { outcomes: [], artifacts: [] });
    const observation = observeRun(plan, manifest, run, run.subject);
    expect(observation.state).toBe('current');
    expect(observation.ready).toBe(false);
    expect(observation.blockers).toEqual([
      'Gate tests is pending.',
      'Artifact report is missing.',
    ]);
  });

  it('rejects an invoker whose delegation differs from the actor profile', () => {
    const run = currentRun(plan, manifest, {
      invokedBy: { kind: 'agent', id: 'codex', principal: '@someone-else' },
    });
    const observation = observeRun(plan, manifest, run, run.subject);

    expect(observation.state).toBe('invalid');
    expect(observation.reason).toContain('does not match actor');
  });

  it('rejects passed outcomes from the wrong producer class', () => {
    const run = currentRun(plan, manifest, { source: 'ci' });
    const observation = observeRun(plan, manifest, run, run.subject);

    expect(observation.state).toBe('invalid');
    expect(observation.reason).toContain('cannot prove gate');
  });

  it('marks evidence stale when the change manifest differs', () => {
    const run = currentRun(plan, manifest, { manifestHash: 'f'.repeat(64) });
    const observation = observeRun(plan, manifest, run, run.subject);

    expect(observation.state).toBe('stale');
    expect(observation.ready).toBe(false);
  });

  it('marks content-identical evidence from another commit as stale', () => {
    const run = currentRun(plan, manifest);
    const target = {
      ...run.subject,
      commit: 'b'.repeat(40),
    };
    const observation = observeRun(plan, manifest, run, target);

    expect(observation.state).toBe('stale');
    expect(observation.reason).toContain('different repository, commit, ref, event');
  });

  it('rejects a producer commit that differs from its declared subject', () => {
    const run = currentRun(plan, manifest, {
      producer: {
        kind: 'local-cli',
        id: 'vitest',
        version: '1',
        commit: 'b'.repeat(40),
      },
    });
    const observation = observeRun(plan, manifest, run, run.subject);

    expect(observation.state).toBe('invalid');
    expect(observation.reason).toContain('producer commit differs');
  });
});
