#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonicalJson, canonicalPrettyJson, sha256 } from './canonical.js';
import { compileGovernance } from './compiler.js';
import { GovernanceError, invariant } from './errors.js';
import {
  assertGitHubIdentityVerified,
  collectGitHubEvidence,
  collectGitHubIdentityEvidence,
  createGitHubCliRunner,
  verifyGitHubEvidence,
} from './github-observer.js';
import {
  assertGitHubRulesetActivationAuthorization,
  buildGitHubRulesetActivationReceipt,
  buildGitHubRulesetPlan,
  createGitHubRuleset,
  readGitHubRefCommit,
} from './github-ruleset.js';
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
  validateGitHubEvidence,
  validateRun,
  verifyMechanismBindings,
  verifyPinnedWorkflowActions,
} from './repository.js';
import {
  RUN_SCHEMA_VERSION,
  type EvidenceSubject,
  type GateOutcome,
  type GovernanceManifest,
  type GovernancePlan,
  type GovernanceRun,
  type GitHubTrustAnchor,
  type IdentityKind,
  type LoadedContract,
  type PullRequestSubject,
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

function gitValue(repoRoot: string, gitArgs: string[]): string {
  return execFileSync('git', gitArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function repositoryFromRemote(repoRoot: string): string {
  const remote = gitValue(repoRoot, ['remote', 'get-url', 'origin']);
  const match =
    /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote) ??
    /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  invariant(match?.[1], 'SUBJECT_INVALID', `Cannot derive GitHub repository from ${remote}`);
  return match[1];
}

function eventObject(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'SUBJECT_INVALID',
    'GitHub event payload must be an object',
  );
  return value as Record<string, unknown>;
}

function objectProperty(
  value: Record<string, unknown>,
  property: string,
): Record<string, unknown> {
  const child = value[property];
  invariant(
    child !== null && typeof child === 'object' && !Array.isArray(child),
    'SUBJECT_INVALID',
    `GitHub event is missing ${property}`,
  );
  return child as Record<string, unknown>;
}

function stringProperty(value: Record<string, unknown>, property: string): string {
  const child = value[property];
  invariant(
    typeof child === 'string' && child !== '',
    'SUBJECT_INVALID',
    `GitHub event is missing ${property}`,
  );
  return child;
}

function pullRequestFromEvent(path: string): PullRequestSubject {
  const event = eventObject(path);
  const pullRequest = objectProperty(event, 'pull_request');
  const head = objectProperty(pullRequest, 'head');
  const base = objectProperty(pullRequest, 'base');
  const number = pullRequest.number;
  invariant(
    Number.isInteger(number) && Number(number) > 0,
    'SUBJECT_INVALID',
    'GitHub event has an invalid pull request number',
  );

  return {
    number: Number(number),
    headCommit: stringProperty(head, 'sha'),
    headRef: stringProperty(head, 'ref'),
    baseCommit: stringProperty(base, 'sha'),
    baseRef: stringProperty(base, 'ref'),
  };
}

function pullRequestFromFlags(args: ParsedArgs): PullRequestSubject {
  const number = Number(requiredFlag(args, 'pull-request-number'));
  invariant(
    Number.isInteger(number) && number > 0,
    'SUBJECT_INVALID',
    'The pull request number must be a positive integer',
  );
  return {
    number,
    headCommit: requiredFlag(args, 'pull-request-head'),
    headRef: requiredFlag(args, 'pull-request-head-ref'),
    baseCommit: requiredFlag(args, 'pull-request-base'),
    baseRef: requiredFlag(args, 'pull-request-base-ref'),
  };
}

function resolveSubject(repoRoot: string, args: ParsedArgs): EvidenceSubject {
  const commit =
    flag(args, 'commit', process.env.GITHUB_SHA) ??
    gitValue(repoRoot, ['rev-parse', 'HEAD']);
  const event = flag(args, 'event', process.env.GITHUB_EVENT_NAME ?? 'local') ?? 'local';
  const ref =
    flag(args, 'ref', process.env.GITHUB_REF) ??
    gitValue(repoRoot, ['symbolic-ref', '-q', 'HEAD']);
  const repository =
    flag(args, 'repository', process.env.GITHUB_REPOSITORY) ??
    repositoryFromRemote(repoRoot);
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const pullRequest =
    event === 'pull_request'
      ? eventPath && existsSync(eventPath)
        ? pullRequestFromEvent(eventPath)
        : pullRequestFromFlags(args)
      : null;

  return { repository, commit, ref, event, pullRequest };
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
  contract: LoadedContract;
  plan: GovernancePlan;
  manifest: GovernanceManifest;
} {
  const contract = loadContract(repoRoot);
  verifyMechanismBindings(repoRoot, contract.mechanisms);
  verifyPinnedWorkflowActions(repoRoot);
  const plan = compileGovernance(contract);
  const manifest = buildManifest(contract, plan);
  return { contract, plan, manifest };
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
  const subject = resolveSubject(repoRoot, args);
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
      commit: subject.commit,
    },
    subject,
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
  const observation = observeRun(plan, manifest, run, subject);
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
  const subject = resolveSubject(repoRoot, args);
  const runPath = requiredFlag(args, 'run');
  const run = JSON.parse(readFileSync(join(repoRoot, runPath), 'utf8')) as unknown;
  validateRun(repoRoot, run);
  const observation = observeRun(plan, manifest, run, subject);
  process.stdout.write(canonicalPrettyJson(observation));
}

function githubTrustAnchor(
  plan: GovernancePlan,
  requestedId: string | undefined,
): GitHubTrustAnchor {
  const candidates = plan.trustAnchors.filter(
    (anchor): anchor is GitHubTrustAnchor => anchor.kind === 'github',
  );
  const anchor = requestedId
    ? candidates.find((candidate) => candidate.id === requestedId)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  invariant(
    anchor,
    'TRUST_ANCHOR_NOT_FOUND',
    requestedId
      ? `Unknown GitHub trust anchor ${requestedId}`
      : 'Use --trust-anchor when more than one GitHub trust anchor exists',
  );
  return anchor;
}

function observeGitHubCommand(repoRoot: string, args: ParsedArgs): void {
  const { plan, manifest } = compile(repoRoot);
  const relativeRunPath = requiredFlag(args, 'run');
  const runPath = resolve(repoRoot, relativeRunPath);
  const rawRun = readFileSync(runPath);
  const run = JSON.parse(rawRun.toString('utf8')) as unknown;
  validateRun(repoRoot, run);
  const anchor = githubTrustAnchor(plan, flag(args, 'trust-anchor'));
  const evidence = collectGitHubEvidence({
    repoRoot,
    runPath: relativeRunPath,
    run,
    anchor,
  });
  validateGitHubEvidence(repoRoot, evidence);
  const observation = verifyGitHubEvidence(
    plan,
    manifest,
    run,
    evidence,
    anchor,
    sha256(rawRun),
  );
  invariant(
    observation.state === 'current' && observation.ready,
    'GITHUB_OBSERVATION_INVALID',
    observation.reason ??
      (observation.blockers.join(' ') || 'GitHub evidence is not ready'),
  );

  writeJson(join(repoRoot, requiredFlag(args, 'out')), evidence);
  const observationPath = flag(args, 'observation-out');
  if (observationPath) {
    writeJson(join(repoRoot, observationPath), observation);
  }
  process.stdout.write(
    `github observation ${run.runId} ${observation.state} ready=${String(
      observation.ready,
    )} activationReady=${String(observation.activationReady)}\n`,
  );
}

function verifyGitHubSignaturesCommand(repoRoot: string, args: ParsedArgs): void {
  const { plan } = compile(repoRoot);
  const subject = resolveSubject(repoRoot, args);
  const anchor = githubTrustAnchor(plan, flag(args, 'trust-anchor'));
  invariant(
    subject.repository === anchor.repository,
    'SUBJECT_INVALID',
    `Execution repository ${subject.repository} does not match ${anchor.repository}`,
  );
  const evidence = collectGitHubIdentityEvidence(
    subject,
    createGitHubCliRunner(repoRoot),
  );
  assertGitHubIdentityVerified(subject, evidence);
  process.stdout.write(
    `github signatures valid commits=${evidence.signatures.length} subject=${subject.commit}\n`,
  );
}

function rulesetPlanCommand(repoRoot: string, args: ParsedArgs): void {
  const { contract, plan, manifest } = compile(repoRoot);
  const anchor = githubTrustAnchor(plan, flag(args, 'trust-anchor'));
  const activationPlan = buildGitHubRulesetPlan(
    contract,
    plan,
    manifest,
    anchor,
  );
  const output = flag(args, 'out');
  if (output) {
    writeJson(join(repoRoot, output), activationPlan);
  }
  process.stdout.write(canonicalPrettyJson(activationPlan));
}

function rulesetApplyCommand(repoRoot: string, args: ParsedArgs): void {
  const { contract, plan, manifest } = compile(repoRoot);
  const anchor = githubTrustAnchor(plan, flag(args, 'trust-anchor'));
  const activationPlan = buildGitHubRulesetPlan(
    contract,
    plan,
    manifest,
    anchor,
  );
  const confirmedPlanHash = requiredFlag(args, 'confirm-plan-hash');
  const confirmedPayloadHash = requiredFlag(args, 'confirm-payload-hash');

  const relativeRunPath = requiredFlag(args, 'run');
  const runPath = resolve(repoRoot, relativeRunPath);
  const rawRun = readFileSync(runPath);
  const run = JSON.parse(rawRun.toString('utf8')) as unknown;
  validateRun(repoRoot, run);
  const localRef = gitValue(repoRoot, ['symbolic-ref', '-q', 'HEAD']);
  const localCommit = gitValue(repoRoot, ['rev-parse', 'HEAD']);
  const runner = createGitHubCliRunner(repoRoot);
  const remoteCommit = readGitHubRefCommit(anchor, runner);

  const preEvidence = collectGitHubEvidence(
    { repoRoot, runPath: relativeRunPath, run, anchor },
    runner,
  );
  validateGitHubEvidence(repoRoot, preEvidence);
  const runFileHash = sha256(rawRun);
  const preObservation = verifyGitHubEvidence(
    plan,
    manifest,
    run,
    preEvidence,
    anchor,
    runFileHash,
  );
  assertGitHubRulesetActivationAuthorization({
    activationPlan,
    anchor,
    run,
    observation: preObservation,
    confirmedPlanHash,
    confirmedPayloadHash,
    localRef,
    localCommit,
    remoteCommit,
  });

  const created = createGitHubRuleset(
    activationPlan,
    anchor,
    preEvidence.rulesets.items,
    runner,
  );
  const postEvidence = collectGitHubEvidence(
    { repoRoot, runPath: relativeRunPath, run, anchor },
    runner,
  );
  validateGitHubEvidence(repoRoot, postEvidence);
  const postObservation = verifyGitHubEvidence(
    plan,
    manifest,
    run,
    postEvidence,
    anchor,
    runFileHash,
  );

  writeJson(join(repoRoot, requiredFlag(args, 'out')), postEvidence);
  writeJson(
    join(repoRoot, requiredFlag(args, 'observation-out')),
    postObservation,
  );
  const receipt = buildGitHubRulesetActivationReceipt({
    activatedAt: new Date().toISOString(),
    activationPlan,
    sourceCommit: run.subject.commit,
    runId: run.runId,
    runFileHash,
    beforeRulesets: preEvidence.rulesets.items,
    afterRulesets: postEvidence.rulesets.items,
    evidence: postEvidence,
    ruleset: created,
  });
  writeJson(join(repoRoot, requiredFlag(args, 'receipt-out')), receipt);

  invariant(
    postObservation.state === 'current' &&
      postObservation.ready &&
      postObservation.activationReady,
    'RULESET_ACTIVATION_INVALID',
    postObservation.reason ?? postObservation.activationBlockers.join(' '),
  );
  process.stdout.write(
    `github ruleset ${created.id} active plan=${activationPlan.planHash} payload=${activationPlan.payloadHash}\n`,
  );
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

  if (args.command === 'observe-github') {
    observeGitHubCommand(repoRoot, args);
    return;
  }

  if (args.command === 'verify-github-signatures') {
    verifyGitHubSignaturesCommand(repoRoot, args);
    return;
  }

  if (args.command === 'ruleset-plan') {
    rulesetPlanCommand(repoRoot, args);
    return;
  }

  if (args.command === 'ruleset-apply') {
    rulesetApplyCommand(repoRoot, args);
    return;
  }

  throw new GovernanceError(
    'CLI_INVALID',
    'Usage: governance <compile|verify|record|observe|observe-github|verify-github-signatures|ruleset-plan|ruleset-apply> [options]',
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
