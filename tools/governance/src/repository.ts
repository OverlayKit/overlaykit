import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { parse as parseYaml } from 'yaml';
import { canonicalHash, sha256 } from './canonical.js';
import { GovernanceError, invariant } from './errors.js';
import type {
  ChangeContract,
  GovernanceDecision,
  GovernanceManifest,
  GovernanceProfile,
  GovernanceRun,
  LoadedContract,
  MechanismRegistry,
} from './types.js';

const GOVERNANCE_PATH = join('.overlaykit', 'governance');
const SCHEMA_FILES = {
  decision: 'decision.schema.json',
  change: 'change.schema.json',
  profile: 'profile.schema.json',
  mechanisms: 'mechanisms.schema.json',
  run: 'run.schema.json',
} as const;

interface SchemaValidators {
  decision: ValidateFunction<GovernanceDecision>;
  change: ValidateFunction<ChangeContract>;
  profile: ValidateFunction<GovernanceProfile>;
  mechanisms: ValidateFunction<MechanismRegistry>;
  run: ValidateFunction<GovernanceRun>;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new GovernanceError('JSON_INVALID', `${relative(process.cwd(), path)}: ${reason}`);
  }
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ');
}

function compileSchemas(schemaDirectory: string): {
  validators: SchemaValidators;
  hashes: Record<string, string>;
} {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const hashes: Record<string, string> = {};
  const schemas = {} as Record<keyof SchemaValidators, object>;

  for (const [key, filename] of Object.entries(SCHEMA_FILES) as Array<
    [keyof SchemaValidators, string]
  >) {
    const path = join(schemaDirectory, filename);
    const raw = readFileSync(path, 'utf8');
    const schema = JSON.parse(raw) as object;
    hashes[filename] = sha256(raw);
    schemas[key] = schema;
  }

  const validators: SchemaValidators = {
    decision: ajv.compile<GovernanceDecision>(schemas.decision),
    change: ajv.compile<ChangeContract>(schemas.change),
    profile: ajv.compile<GovernanceProfile>(schemas.profile),
    mechanisms: ajv.compile<MechanismRegistry>(schemas.mechanisms),
    run: ajv.compile<GovernanceRun>(schemas.run),
  };

  return { validators, hashes };
}

function assertSchema<T>(
  validator: ValidateFunction<T>,
  value: unknown,
  path: string,
): asserts value is T {
  invariant(
    validator(value),
    'SCHEMA_INVALID',
    `${path}: ${formatAjvErrors(validator.errors)}`,
  );
}

export function findRepoRoot(start = process.cwd()): string {
  let current = resolve(start);

  while (current !== dirname(current)) {
    if (
      existsSync(join(current, 'package.json')) &&
      existsSync(join(current, GOVERNANCE_PATH, 'profile.json'))
    ) {
      return current;
    }

    const parent = dirname(current);
    current = parent;
  }

  throw new GovernanceError('REPOSITORY_NOT_FOUND', 'Could not locate repository root');
}

export function loadContract(repoRoot: string): LoadedContract {
  const governanceDirectory = join(repoRoot, GOVERNANCE_PATH);
  const schemaDirectory = join(governanceDirectory, 'schemas');
  const { validators, hashes } = compileSchemas(schemaDirectory);

  const decisionDirectory = join(governanceDirectory, 'decisions');
  const decisions = readdirSync(decisionDirectory)
    .filter((filename) => filename.endsWith('.json'))
    .sort()
    .map((filename) => {
      const path = join(decisionDirectory, filename);
      const raw = readFileSync(path, 'utf8');
      const decision = JSON.parse(raw) as unknown;
      assertSchema(validators.decision, decision, relative(repoRoot, path));

      return {
        decision,
        contentHash: sha256(raw),
        path: relative(repoRoot, path),
      };
    });

  const changeDirectory = join(governanceDirectory, 'changes');
  const changes = readdirSync(changeDirectory)
    .filter((filename) => filename.endsWith('.json'))
    .sort()
    .map((filename) => {
      const path = join(changeDirectory, filename);
      const raw = readFileSync(path, 'utf8');
      const change = JSON.parse(raw) as unknown;
      assertSchema(validators.change, change, relative(repoRoot, path));

      for (const claim of change.claims) {
        if (claim.kind === 'fact' || claim.kind === 'inference') {
          invariant(
            claim.evidence !== null,
            'CLAIM_UNPROVEN',
            `${change.id} ${claim.kind} claim has no evidence: ${claim.statement}`,
          );
        }
      }

      if (change.status === 'approved' || change.status === 'implemented') {
        invariant(
          !change.claims.some((claim) => claim.kind === 'unknown' && claim.blocking),
          'CHANGE_BLOCKED',
          `${change.id} has a blocking unknown`,
        );
      }

      return {
        change,
        contentHash: sha256(raw),
        path: relative(repoRoot, path),
      };
    });

  const profilePath = join(governanceDirectory, 'profile.json');
  const profile = readJson(profilePath);
  assertSchema(validators.profile, profile, relative(repoRoot, profilePath));

  const mechanismsPath = join(governanceDirectory, 'mechanisms.json');
  const mechanisms = readJson(mechanismsPath);
  assertSchema(validators.mechanisms, mechanisms, relative(repoRoot, mechanismsPath));

  return {
    decisions,
    changes,
    profile,
    mechanisms,
    schemas: hashes,
    schemasHash: canonicalHash(hashes),
    mechanismsHash: canonicalHash(mechanisms),
  };
}

function objectAtPath(value: unknown, segments: string[]): unknown {
  let current = value;

  for (const segment of segments) {
    invariant(
      current !== null && typeof current === 'object' && !Array.isArray(current),
      'MECHANISM_MISSING',
      `Cannot resolve object path segment ${segment}`,
    );
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function commandExistsInWorkflow(job: unknown, expectedCommand: string): boolean {
  if (job === null || typeof job !== 'object' || Array.isArray(job)) {
    return false;
  }

  const steps = (job as Record<string, unknown>).steps;
  if (!Array.isArray(steps)) {
    return false;
  }

  return steps.some((step) => {
    if (step === null || typeof step !== 'object' || Array.isArray(step)) {
      return false;
    }

    const run = (step as Record<string, unknown>).run;
    return (
      typeof run === 'string' &&
      run
        .split('\n')
        .map((line) => line.trim())
        .includes(expectedCommand)
    );
  });
}

export function verifyMechanismBindings(
  repoRoot: string,
  registry: MechanismRegistry,
): void {
  for (const mechanism of registry.mechanisms) {
    const [relativePath, fragment] = mechanism.locator.split('#', 2);
    invariant(relativePath, 'MECHANISM_INVALID', `${mechanism.id} has an empty locator`);

    if (mechanism.kind === 'github-ruleset' || mechanism.kind === 'human-review') {
      invariant(
        !mechanism.enforcementCapable,
        'MECHANISM_UNOBSERVED',
        `${mechanism.id} is external and cannot be enforcementCapable without an observer`,
      );
      continue;
    }

    const path = join(repoRoot, relativePath);
    invariant(
      existsSync(path) && statSync(path).isFile(),
      'MECHANISM_MISSING',
      `${mechanism.id} points to missing file ${relativePath}`,
    );
    invariant(
      mechanism.expectedCommand !== null,
      'MECHANISM_INVALID',
      `${mechanism.id} must declare expectedCommand`,
    );

    if (mechanism.kind === 'local-command') {
      invariant(fragment, 'MECHANISM_INVALID', `${mechanism.id} needs a JSON locator fragment`);
      const packageJson = readJson(path);
      const actual = objectAtPath(packageJson, fragment.split('.'));
      invariant(
        actual === mechanism.expectedCommand,
        'MECHANISM_DRIFT',
        `${mechanism.id} expected "${mechanism.expectedCommand}" at ${mechanism.locator}`,
      );
      continue;
    }

    invariant(fragment, 'MECHANISM_INVALID', `${mechanism.id} needs a workflow job fragment`);
    const workflow = parseYaml(readFileSync(path, 'utf8')) as unknown;
    const job = objectAtPath(workflow, fragment.split('.'));
    invariant(
      commandExistsInWorkflow(job, mechanism.expectedCommand),
      'MECHANISM_DRIFT',
      `${mechanism.id} cannot find "${mechanism.expectedCommand}" in ${mechanism.locator}`,
    );
  }
}

export function verifyPinnedWorkflowActions(repoRoot: string): void {
  const workflowDirectory = join(repoRoot, '.github', 'workflows');
  if (!existsSync(workflowDirectory)) {
    return;
  }

  for (const filename of readdirSync(workflowDirectory).sort()) {
    if (!filename.endsWith('.yml') && !filename.endsWith('.yaml')) {
      continue;
    }

    const path = join(workflowDirectory, filename);
    const workflow = parseYaml(readFileSync(path, 'utf8')) as unknown;
    const serialized = JSON.stringify(workflow);
    const uses = [...serialized.matchAll(/"uses":"([^"]+)"/g)].map((match) => match[1]);

    for (const reference of uses) {
      if (!reference || reference.startsWith('./')) {
        continue;
      }

      invariant(
        /@[a-f0-9]{40}$/i.test(reference),
        'ACTION_UNPINNED',
        `${filename} uses an unpinned action: ${reference}`,
      );
    }
  }
}

export function validateRun(repoRoot: string, run: unknown): asserts run is GovernanceRun {
  const schemaDirectory = join(repoRoot, GOVERNANCE_PATH, 'schemas');
  const { validators } = compileSchemas(schemaDirectory);
  assertSchema(validators.run, run, 'governance run');
}

export function readStoredManifest(repoRoot: string): GovernanceManifest {
  return readJson(join(repoRoot, GOVERNANCE_PATH, 'manifest.json')) as GovernanceManifest;
}

export function readBaseManifest(repoRoot: string, baseRef: string): GovernanceManifest | null {
  try {
    const raw = execFileSync(
      'git',
      ['show', `${baseRef}:${GOVERNANCE_PATH}/manifest.json`],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return JSON.parse(raw) as GovernanceManifest;
  } catch {
    return null;
  }
}
