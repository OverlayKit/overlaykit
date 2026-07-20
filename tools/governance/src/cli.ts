#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson, canonicalPrettyJson } from './canonical.js';
import { compileGovernance } from './compiler.js';
import { GovernanceError, invariant } from './errors.js';
import {
  buildManifest,
  immutabilityViolations,
  verifyManifestIntegrity,
} from './manifest.js';
import { observeRun } from './projector.js';
import {
  findRepoRoot,
  loadContract,
  readBaseManifest,
  readStoredManifest,
  validateRun,
  verifyMechanismBindings,
  verifyPinnedWorkflowActions,
} from './repository.js';
import {
  RUN_SCHEMA_VERSION,
  type GateOutcome,
  type GovernanceManifest,
  type GovernancePlan,
  type GovernanceRun,
  type IdentityKind,
} from './types.js';

interface ParsedArgs {
  command: string | undefined;
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...tokens] = argv;
  const flags = new Map<string, string[]>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    invariant(
      token !== undefined && token.startsWith('--'),
      'CLI_INVALID',
      `Unexpected argument: ${token ?? ''}`,
    );
    const name = token.slice(2);
    const next = tokens[index + 1];
    const value = next && !next.startsWith('--') ? next : 'true';

    if (value !== 'true') {
      index += 1;
    }

    flags.set(name, [...(flags.get(name) ?? []), value]);
  }

  return { command, flags };
}

function flag(args: ParsedArgs, name: string, fallback?: string): string | undefined {
  return args.flags.get(name)?.at(-1) ?? fallback;
}

function requiredFlag(args: ParsedArgs, name: string): string {
  const value = flag(args, name);
  invariant(value, 'CLI_INVALID', `Missing --${name}`);
  return value;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canonicalPrettyJson(value));
}

function generatedPaths(repoRoot: string): { plan: string; manifest: string } {
  const governanceDirectory = join(repoRoot, '.overlaykit', 'governance');
  return {
    plan: join(governanceDirectory, 'plan.json'),
    manifest: join(governanceDirectory, 'manifest.json'),
  };
}

function compile(repoRoot: string): {
  plan: GovernancePlan;
  manifest: GovernanceManifest;
} {
  const contract = loadContract(repoRoot);
  verifyMechanismBindings(repoRoot, contract.mechanisms);
  verifyPinnedWorkflowActions(repoRoot);
  const plan = compileGovernance(contract);
  const manifest = buildManifest(contract, plan);
  return { plan, manifest };
}

function compileCommand(repoRoot: string, args: ParsedArgs): void {
  const { plan, manifest } = compile(repoRoot);

  if (flag(args, 'write') === 'true') {
    const paths = generatedPaths(repoRoot);
    writeJson(paths.plan, plan);
    writeJson(paths.manifest, manifest);
  }

  process.stdout.write(
    `${JSON.stringify({
      profile: `${plan.profileName}@${plan.profileVersion}`,
      planHash: plan.planHash,
      decisions: plan.decisions.length,
      gates: plan.gates.length,
      artifacts: plan.artifacts.length,
    })}\n`,
  );
}

function verifyCommand(repoRoot: string, args: ParsedArgs): void {
  const contract = loadContract(repoRoot);
  verifyMechanismBindings(repoRoot, contract.mechanisms);
  verifyPinnedWorkflowActions(repoRoot);
  const plan = compileGovernance(contract);
  const manifest = buildManifest(contract, plan);
  const paths = generatedPaths(repoRoot);
  const storedPlan = JSON.parse(readFileSync(paths.plan, 'utf8')) as GovernancePlan;
  const storedManifest = readStoredManifest(repoRoot);

  invariant(
    canonicalJson(storedPlan) === canonicalJson(plan),
    'PLAN_DRIFT',
    'Stored plan.json differs from deterministic compilation',
  );
  invariant(
    canonicalJson(storedManifest) === canonicalJson(manifest),
    'MANIFEST_DRIFT',
    'Stored manifest.json differs from deterministic compilation',
  );
  invariant(
    verifyManifestIntegrity(storedManifest, contract, plan),
    'MANIFEST_INVALID',
    'Stored manifest integrity check failed',
  );

  const baseRef = flag(args, 'base-ref', process.env.GOVERNANCE_BASE_REF);
  if (baseRef) {
    const baseManifest = readBaseManifest(repoRoot, baseRef);
    if (baseManifest) {
      const violations = immutabilityViolations(baseManifest, storedManifest);
      invariant(
        violations.length === 0,
        'DECISION_MUTATED',
        `Accepted decisions changed or disappeared: ${violations.join(', ')}`,
      );
    }
  }

  process.stdout.write(`governance ok ${plan.planHash}\n`);
}

function normalizeOutcome(value: string): GateOutcome {
  const normalized: Record<string, GateOutcome> = {
    success: 'passed',
    passed: 'passed',
    failure: 'failed',
    failed: 'failed',
    cancelled: 'failed',
    skipped: 'pending',
    pending: 'pending',
    waived: 'waived',
  };
  const outcome = normalized[value];
  invariant(outcome, 'CLI_INVALID', `Unsupported outcome: ${value}`);
  return outcome;
}

function recordCommand(repoRoot: string, args: ParsedArgs): void {
  const { plan, manifest } = compile(repoRoot);
  const now = new Date().toISOString();
  const producerRef =
    flag(args, 'producer-ref') ??
    (process.env.GITHUB_SERVER_URL &&
    process.env.GITHUB_REPOSITORY &&
    process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : 'local://governance-run');
  const outcomeArgs = args.flags.get('outcome') ?? [];
  const artifactArgs = args.flags.get('artifact') ?? [];
  const outcomeMap = new Map<string, GateOutcome>();

  for (const item of outcomeArgs) {
    const separator = item.indexOf('=');
    invariant(separator > 0, 'CLI_INVALID', `Invalid --outcome value: ${item}`);
    const gate = item.slice(0, separator);
    invariant(!outcomeMap.has(gate), 'CLI_INVALID', `Duplicate --outcome gate: ${gate}`);
    outcomeMap.set(gate, normalizeOutcome(item.slice(separator + 1)));
  }

  const kind = (flag(args, 'invoker-kind', process.env.GOVERNANCE_INVOKER_KIND ?? 'ci') ??
    'ci') as IdentityKind;
  const run: GovernanceRun = {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId:
      flag(args, 'run-id') ??
      process.env.GITHUB_RUN_ID ??
      `local-${Date.now().toString(36)}`,
    profileHash: plan.profileHash,
    planHash: plan.planHash,
    manifestHash: manifest.contentHash,
    invokedBy: {
      kind,
      id:
        flag(args, 'invoker-id') ??
        process.env.GOVERNANCE_INVOKER_ID ??
        process.env.GITHUB_ACTOR ??
        'unknown',
      principal:
        flag(args, 'principal') ??
        process.env.GOVERNANCE_PRINCIPAL ??
        process.env.GITHUB_ACTOR ??
        null,
    },
    producer: {
      kind: flag(args, 'producer-kind', 'ci-workflow') ?? 'ci-workflow',
      id: flag(args, 'producer-id', '.github/workflows/ci.yml') ?? '.github/workflows/ci.yml',
      version: flag(args, 'producer-version', process.env.GITHUB_WORKFLOW_REF) ?? null,
      commit: flag(args, 'commit', process.env.GITHUB_SHA) ?? null,
    },
    source: flag(args, 'source', process.env.GITHUB_ACTIONS ? 'ci' : 'local') ?? 'local',
    startedAt: flag(args, 'started-at', now) ?? now,
    finishedAt: flag(args, 'finished-at', now) ?? now,
    assumptions: plan.assumptions,
    outcomes: plan.gates.map((gate) => {
      const outcome = outcomeMap.get(gate.id) ?? 'pending';
      return {
        gate: gate.id,
        outcome,
        producerRef: outcome === 'passed' ? producerRef : null,
        justification: outcome === 'waived' ? requiredFlag(args, 'waiver-justification') : null,
        boundTo: gate.boundTo,
      };
    }),
    artifacts: artifactArgs.map((item) => {
      const separator = item.indexOf('=');
      invariant(separator > 0, 'CLI_INVALID', `Invalid --artifact value: ${item}`);
      const artifact = item.slice(0, separator);
      const producerRef = item.slice(separator + 1);
      invariant(
        plan.artifacts.some((candidate) => candidate.id === artifact),
        'CLI_INVALID',
        `Unknown --artifact id: ${artifact}`,
      );
      return {
        artifact,
        producerRef,
        contentHash: artifact === 'governance-plan' ? plan.planHash : null,
      };
    }),
  };

  validateRun(repoRoot, run);
  const observation = observeRun(plan, manifest, run);
  invariant(
    observation.state === 'current',
    'RUN_INVALID',
    observation.reason ?? 'Run is not current',
  );

  const output = join(repoRoot, requiredFlag(args, 'out'));
  writeJson(output, run);
  process.stdout.write(
    `governance run ${run.runId} ${observation.state} ready=${String(observation.ready)}\n`,
  );
}

function observeCommand(repoRoot: string, args: ParsedArgs): void {
  const { plan, manifest } = compile(repoRoot);
  const runPath = requiredFlag(args, 'run');
  const run = JSON.parse(readFileSync(join(repoRoot, runPath), 'utf8')) as unknown;
  validateRun(repoRoot, run);
  const observation = observeRun(plan, manifest, run);
  process.stdout.write(canonicalPrettyJson(observation));
}

export function main(argv = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  const repoRoot = findRepoRoot();

  if (args.command === 'compile') {
    compileCommand(repoRoot, args);
    return;
  }

  if (args.command === 'verify') {
    verifyCommand(repoRoot, args);
    return;
  }

  if (args.command === 'record') {
    recordCommand(repoRoot, args);
    return;
  }

  if (args.command === 'observe') {
    observeCommand(repoRoot, args);
    return;
  }

  throw new GovernanceError(
    'CLI_INVALID',
    'Usage: governance <compile|verify|record|observe> [options]',
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
