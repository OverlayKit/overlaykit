import { canonicalHash, canonicalJson } from './canonical.js';
import { invariant } from './errors.js';
import {
  githubRulesetActivationBlockers,
  githubRulesetAppliesToRef,
  normalizeGitHubRuleset,
  type GitHubCommandRunner,
} from './github-observer.js';
import type {
  GitHubRulesetEvidence,
  GitHubObservation,
  GitHubTrustAnchor,
  GovernanceManifest,
  GovernancePlan,
  GovernanceRun,
  LoadedContract,
} from './types.js';

export const GITHUB_RULESET_PLAN_SCHEMA_VERSION =
  'overlaykit-github-ruleset-plan/v1' as const;
export const GITHUB_RULESET_RECEIPT_SCHEMA_VERSION =
  'overlaykit-github-ruleset-activation/v1' as const;

interface GitHubRulesetRulePayload {
  type: string;
  parameters?: Record<string, unknown>;
}

export interface GitHubRulesetCreatePayload {
  name: string;
  target: 'branch';
  enforcement: 'active';
  bypass_actors: unknown[];
  conditions: {
    ref_name: {
      include: string[];
      exclude: string[];
    };
  };
  rules: GitHubRulesetRulePayload[];
}

export interface GitHubRulesetPlan {
  schemaVersion: typeof GITHUB_RULESET_PLAN_SCHEMA_VERSION;
  trustAnchor: string;
  authorizationChange: string;
  repository: string;
  protectedRef: string;
  profileHash: string;
  planHash: string;
  manifestHash: string;
  payloadHash: string;
  payload: GitHubRulesetCreatePayload;
}

export interface GitHubRulesetActivationReceipt {
  schemaVersion: typeof GITHUB_RULESET_RECEIPT_SCHEMA_VERSION;
  activatedAt: string;
  trustAnchor: string;
  authorizationChange: string;
  repository: string;
  protectedRef: string;
  sourceCommit: string;
  runId: string;
  runFileHash: string;
  profileHash: string;
  planHash: string;
  manifestHash: string;
  payloadHash: string;
  beforeRulesetsHash: string;
  afterRulesetsHash: string;
  evidenceHash: string;
  ruleset: {
    id: number;
    name: string;
  };
}

export function assertGitHubRulesetActivationAuthorization(options: {
  activationPlan: GitHubRulesetPlan;
  anchor: GitHubTrustAnchor;
  run: GovernanceRun;
  observation: GitHubObservation;
  confirmedPlanHash: string;
  confirmedPayloadHash: string;
  localRef: string;
  localCommit: string;
  remoteCommit: string;
}): void {
  const { activationPlan, anchor, run, observation } = options;
  invariant(
    options.confirmedPlanHash === activationPlan.planHash,
    'RULESET_CONFIRMATION_FAILED',
    'The confirmed plan hash differs from the compiled plan',
  );
  invariant(
    options.confirmedPayloadHash === activationPlan.payloadHash,
    'RULESET_CONFIRMATION_FAILED',
    'The confirmed payload hash differs from the compiled ruleset payload',
  );
  invariant(
    run.subject.repository === anchor.repository &&
      run.subject.ref === anchor.protectedRef &&
      run.subject.event === 'push' &&
      run.subject.pullRequest === null,
    'RULESET_PRECONDITION_FAILED',
    'Ruleset activation requires an attested push run for the protected ref',
  );
  invariant(
    options.localRef === anchor.protectedRef &&
      options.localCommit === run.subject.commit,
    'RULESET_PRECONDITION_FAILED',
    'Local HEAD must be the attested protected-main commit',
  );
  invariant(
    options.remoteCommit === run.subject.commit,
    'RULESET_PRECONDITION_FAILED',
    'The live GitHub protected ref differs from the attested run commit',
  );
  invariant(
    observation.state === 'current' && observation.ready,
    'RULESET_PRECONDITION_FAILED',
    observation.reason ?? observation.blockers.join(' '),
  );
  invariant(
    !observation.activationReady,
    'RULESET_ALREADY_ACTIVE',
    'The compiled ruleset is already active',
  );
}

function pullRequestRule(anchor: GitHubTrustAnchor): GitHubRulesetRulePayload {
  const requirements = anchor.ruleset;
  return {
    type: 'pull_request',
    parameters: {
      allowed_merge_methods: [...requirements.allowedMergeMethods].sort(),
      dismiss_stale_reviews_on_push: requirements.dismissStaleReviewsOnPush,
      require_code_owner_review: requirements.requireCodeOwnerReview,
      require_last_push_approval: requirements.requireLastPushApproval,
      required_approving_review_count: requirements.minimumApprovals,
      required_review_thread_resolution:
        requirements.requireReviewThreadResolution,
    },
  };
}

function statusChecksRule(anchor: GitHubTrustAnchor): GitHubRulesetRulePayload {
  const requirements = anchor.ruleset;
  return {
    type: 'required_status_checks',
    parameters: {
      do_not_enforce_on_create: requirements.doNotEnforceOnCreate,
      required_status_checks: [...requirements.requiredStatusChecks]
        .sort()
        .map((context) => ({
          context,
          integration_id: anchor.checkAppId,
        })),
      strict_required_status_checks_policy:
        requirements.strictRequiredStatusChecksPolicy,
    },
  };
}

function rulePayload(type: string, anchor: GitHubTrustAnchor): GitHubRulesetRulePayload {
  if (type === 'pull_request') {
    return pullRequestRule(anchor);
  }
  if (type === 'required_status_checks') {
    return statusChecksRule(anchor);
  }
  invariant(
    ['deletion', 'non_fast_forward', 'required_signatures'].includes(type),
    'RULESET_UNSUPPORTED',
    `Cannot create unsupported GitHub ruleset rule ${type}`,
  );
  return { type };
}

export function buildGitHubRulesetPayload(
  anchor: GitHubTrustAnchor,
): GitHubRulesetCreatePayload {
  return {
    name: anchor.ruleset.name,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: {
      ref_name: {
        include: [anchor.protectedRef],
        exclude: [],
      },
    },
    rules: [...anchor.ruleset.requiredRules]
      .sort()
      .map((type) => rulePayload(type, anchor)),
  };
}

export function buildGitHubRulesetPlan(
  contract: LoadedContract,
  plan: GovernancePlan,
  manifest: GovernanceManifest,
  anchor: GitHubTrustAnchor,
): GitHubRulesetPlan {
  const authorization = contract.changes.find(
    (record) => record.change.id === anchor.ruleset.activationChange,
  );
  invariant(
    authorization?.change.status === 'implemented',
    'RULESET_UNAUTHORIZED',
    `Ruleset activation requires implemented ${anchor.ruleset.activationChange}`,
  );
  const payload = buildGitHubRulesetPayload(anchor);
  return {
    schemaVersion: GITHUB_RULESET_PLAN_SCHEMA_VERSION,
    trustAnchor: anchor.id,
    authorizationChange: authorization.change.id,
    repository: anchor.repository,
    protectedRef: anchor.protectedRef,
    profileHash: plan.profileHash,
    planHash: plan.planHash,
    manifestHash: manifest.contentHash,
    payloadHash: canonicalHash(payload),
    payload,
  };
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

export function readGitHubRefCommit(
  anchor: GitHubTrustAnchor,
  runner: GitHubCommandRunner,
): string {
  const prefix = 'refs/heads/';
  invariant(
    anchor.protectedRef.startsWith(prefix),
    'RULESET_PRECONDITION_FAILED',
    `Protected ref ${anchor.protectedRef} is not a branch`,
  );
  const branch = anchor.protectedRef.slice(prefix.length);
  const response = parseJson(
    runner.run(['api', `repos/${anchor.repository}/git/ref/heads/${branch}`]),
    'GitHub ref lookup',
  );
  invariant(
    response !== null && typeof response === 'object' && !Array.isArray(response),
    'RULESET_PRECONDITION_FAILED',
    'GitHub ref lookup returned an invalid object',
  );
  const object = (response as Record<string, unknown>).object;
  invariant(
    object !== null && typeof object === 'object' && !Array.isArray(object),
    'RULESET_PRECONDITION_FAILED',
    'GitHub ref lookup has no target object',
  );
  const sha = (object as Record<string, unknown>).sha;
  invariant(
    typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha),
    'RULESET_PRECONDITION_FAILED',
    'GitHub ref lookup has an invalid commit',
  );
  return sha;
}

export function createGitHubRuleset(
  activationPlan: GitHubRulesetPlan,
  anchor: GitHubTrustAnchor,
  existingRulesets: GitHubRulesetEvidence[],
  runner: GitHubCommandRunner,
): GitHubRulesetEvidence {
  invariant(
    activationPlan.trustAnchor === anchor.id &&
      activationPlan.repository === anchor.repository &&
      activationPlan.protectedRef === anchor.protectedRef,
    'RULESET_PLAN_INVALID',
    'Ruleset plan does not match the selected trust anchor',
  );
  invariant(
    activationPlan.payloadHash === canonicalHash(activationPlan.payload) &&
      canonicalJson(activationPlan.payload) ===
        canonicalJson(buildGitHubRulesetPayload(anchor)),
    'RULESET_PLAN_INVALID',
    'Ruleset payload differs from the compiled trust anchor',
  );
  invariant(
    !existingRulesets.some((ruleset) => ruleset.name === anchor.ruleset.name),
    'RULESET_ALREADY_EXISTS',
    `Ruleset ${anchor.ruleset.name} already exists; this controller is create-only`,
  );
  invariant(
    !existingRulesets.some((ruleset) =>
      githubRulesetAppliesToRef(ruleset, anchor.protectedRef),
    ),
    'RULESET_PRECONDITION_FAILED',
    `An existing ruleset already applies to ${anchor.protectedRef}`,
  );

  const response = parseJson(
    runner.run(
      [
        'api',
        '--method',
        'POST',
        `repos/${anchor.repository}/rulesets`,
        '--input',
        '-',
      ],
      canonicalJson(activationPlan.payload),
    ),
    'GitHub ruleset creation',
  );
  const created = normalizeGitHubRuleset(response);
  const blockers = githubRulesetActivationBlockers(anchor, [created]);
  invariant(
    blockers.length === 0,
    'RULESET_ACTIVATION_INVALID',
    blockers.join(' '),
  );
  return created;
}

export function buildGitHubRulesetActivationReceipt(options: {
  activatedAt: string;
  activationPlan: GitHubRulesetPlan;
  sourceCommit: string;
  runId: string;
  runFileHash: string;
  beforeRulesets: GitHubRulesetEvidence[];
  afterRulesets: GitHubRulesetEvidence[];
  evidence: unknown;
  ruleset: GitHubRulesetEvidence;
}): GitHubRulesetActivationReceipt {
  const { activationPlan } = options;
  return {
    schemaVersion: GITHUB_RULESET_RECEIPT_SCHEMA_VERSION,
    activatedAt: options.activatedAt,
    trustAnchor: activationPlan.trustAnchor,
    authorizationChange: activationPlan.authorizationChange,
    repository: activationPlan.repository,
    protectedRef: activationPlan.protectedRef,
    sourceCommit: options.sourceCommit,
    runId: options.runId,
    runFileHash: options.runFileHash,
    profileHash: activationPlan.profileHash,
    planHash: activationPlan.planHash,
    manifestHash: activationPlan.manifestHash,
    payloadHash: activationPlan.payloadHash,
    beforeRulesetsHash: canonicalHash(options.beforeRulesets),
    afterRulesetsHash: canonicalHash(options.afterRulesets),
    evidenceHash: canonicalHash(options.evidence),
    ruleset: {
      id: options.ruleset.id,
      name: options.ruleset.name,
    },
  };
}
