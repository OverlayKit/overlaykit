import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { canonicalHash, canonicalJson, sha256 } from './canonical.js';
import { invariant } from './errors.js';
import { observeRun } from './projector.js';
import {
  GITHUB_EVIDENCE_SCHEMA_VERSION,
  type GitHubAttestationEvidence,
  type GitHubEvidence,
  type GitHubObservation,
  type GitHubPullRequestEvidence,
  type GitHubRulesetEvidence,
  type GitHubRulesetRuleEvidence,
  type GitHubSignatureEvidence,
  type GitHubTrustAnchor,
  type GovernanceManifest,
  type GovernancePlan,
  type GovernanceRun,
} from './types.js';

export interface GitHubCommandRunner {
  run(args: string[]): string;
}

export interface CollectGitHubEvidenceOptions {
  repoRoot: string;
  runPath: string;
  run: GovernanceRun;
  anchor: GitHubTrustAnchor;
  observedAt?: string;
}

type JsonObject = Record<string, unknown>;

export function createGitHubCliRunner(cwd: string): GitHubCommandRunner {
  return {
    run(args) {
      return execFileSync('gh', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    },
  };
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

function object(value: unknown, label: string): JsonObject {
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'GITHUB_EVIDENCE_INVALID',
    `${label} must be an object`,
  );
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  invariant(Array.isArray(value), 'GITHUB_EVIDENCE_INVALID', `${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  invariant(
    typeof value === 'string' && value !== '',
    'GITHUB_EVIDENCE_INVALID',
    `${label} must be a non-empty string`,
  );
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  return string(value, label);
}

function number(value: unknown, label: string): number {
  invariant(
    typeof value === 'number' && Number.isInteger(value) && value > 0,
    'GITHUB_EVIDENCE_INVALID',
    `${label} must be a positive integer`,
  );
  return value;
}

function property(value: JsonObject, name: string, label: string): unknown {
  invariant(
    Object.hasOwn(value, name),
    'GITHUB_EVIDENCE_INVALID',
    `${label} is missing ${name}`,
  );
  return value[name];
}

function api(runner: GitHubCommandRunner, endpoint: string): unknown {
  return parseJson(runner.run(['api', endpoint]), `gh api ${endpoint}`);
}

function pagedApi(runner: GitHubCommandRunner, endpoint: string): unknown[] {
  const pages = array(
    parseJson(
      runner.run(['api', '--paginate', '--slurp', endpoint]),
      `gh api ${endpoint}`,
    ),
    `${endpoint} pages`,
  );
  return pages.flatMap((page, index) => array(page, `${endpoint} page ${index + 1}`));
}

function normalizeSignature(value: unknown): GitHubSignatureEvidence {
  const commit = object(value, 'commit response');
  const commitSha = string(property(commit, 'sha', 'commit response'), 'commit sha');
  const gitCommit = object(property(commit, 'commit', 'commit response'), 'git commit');
  const verification = object(
    property(gitCommit, 'verification', 'git commit'),
    'commit verification',
  );

  return {
    commit: commitSha,
    verified: property(verification, 'verified', 'commit verification') === true,
    reason: string(
      property(verification, 'reason', 'commit verification'),
      'verification reason',
    ),
    verifiedAt: nullableString(verification.verified_at ?? null, 'verification timestamp'),
  };
}

function normalizePullRequest(value: unknown): GitHubPullRequestEvidence {
  const pullRequest = object(value, 'pull request');
  const head = object(property(pullRequest, 'head', 'pull request'), 'pull request head');
  const base = object(property(pullRequest, 'base', 'pull request'), 'pull request base');

  return {
    number: number(property(pullRequest, 'number', 'pull request'), 'pull request number'),
    headCommit: string(property(head, 'sha', 'pull request head'), 'pull request head sha'),
    headRef: string(property(head, 'ref', 'pull request head'), 'pull request head ref'),
    baseCommit: string(property(base, 'sha', 'pull request base'), 'pull request base sha'),
    baseRef: string(property(base, 'ref', 'pull request base'), 'pull request base ref'),
    state: string(property(pullRequest, 'state', 'pull request'), 'pull request state'),
    commits: [],
  };
}

function normalizeRulesetRule(value: unknown): GitHubRulesetRuleEvidence {
  const rule = object(value, 'ruleset rule');
  const parameters = rule.parameters;
  return {
    type: string(property(rule, 'type', 'ruleset rule'), 'ruleset rule type'),
    parameters:
      parameters === undefined || parameters === null
        ? null
        : object(parameters, 'ruleset rule parameters'),
  };
}

function normalizeRuleset(value: unknown): GitHubRulesetEvidence {
  const ruleset = object(value, 'ruleset');
  const conditions = ruleset.conditions;
  const bypassActors = ruleset.bypass_actors;

  return {
    id: number(property(ruleset, 'id', 'ruleset'), 'ruleset id'),
    name: string(property(ruleset, 'name', 'ruleset'), 'ruleset name'),
    target: string(property(ruleset, 'target', 'ruleset'), 'ruleset target'),
    enforcement: string(
      property(ruleset, 'enforcement', 'ruleset'),
      'ruleset enforcement',
    ),
    source: string(property(ruleset, 'source', 'ruleset'), 'ruleset source'),
    sourceType: string(
      property(ruleset, 'source_type', 'ruleset'),
      'ruleset source type',
    ),
    conditions:
      conditions === undefined || conditions === null
        ? null
        : object(conditions, 'ruleset conditions'),
    bypassActors:
      bypassActors === undefined || bypassActors === null
        ? []
        : array(bypassActors, 'ruleset bypass actors'),
    rules: array(property(ruleset, 'rules', 'ruleset'), 'ruleset rules')
      .map(normalizeRulesetRule)
      .sort((left, right) => left.type.localeCompare(right.type)),
  };
}

function normalizeAttestationResult(value: unknown): GitHubAttestationEvidence {
  const result = object(value, 'attestation result');
  const verification = object(
    property(result, 'verificationResult', 'attestation result'),
    'attestation verification result',
  );
  const signature = object(
    property(verification, 'signature', 'attestation verification result'),
    'attestation signature',
  );
  const certificate = object(
    property(signature, 'certificate', 'attestation signature'),
    'attestation certificate',
  );
  const statement = object(
    property(verification, 'statement', 'attestation verification result'),
    'attestation statement',
  );
  const subjects = array(property(statement, 'subject', 'attestation statement'), 'subjects');
  invariant(
    subjects.length === 1,
    'GITHUB_EVIDENCE_INVALID',
    `Expected exactly one attestation subject, received ${subjects.length}`,
  );
  const subject = object(subjects[0], 'attestation subject');
  const digest = object(property(subject, 'digest', 'attestation subject'), 'subject digest');

  return {
    subjectName: string(property(subject, 'name', 'attestation subject'), 'subject name'),
    subjectDigest: string(property(digest, 'sha256', 'subject digest'), 'subject digest'),
    signerWorkflow: string(
      property(certificate, 'buildSignerURI', 'attestation certificate'),
      'attestation signer workflow',
    ),
    sourceRepository: string(
      property(certificate, 'sourceRepositoryURI', 'attestation certificate'),
      'attestation source repository',
    ),
    sourceCommit: string(
      property(certificate, 'sourceRepositoryDigest', 'attestation certificate'),
      'attestation source commit',
    ),
    sourceRef: string(
      property(certificate, 'sourceRepositoryRef', 'attestation certificate'),
      'attestation source ref',
    ),
    oidcIssuer: string(
      property(certificate, 'issuer', 'attestation certificate'),
      'attestation OIDC issuer',
    ),
    runnerEnvironment: string(
      property(certificate, 'runnerEnvironment', 'attestation certificate'),
      'attestation runner environment',
    ),
    event: string(
      property(certificate, 'githubWorkflowTrigger', 'attestation certificate'),
      'attestation event',
    ),
    invocation: string(
      property(certificate, 'runInvocationURI', 'attestation certificate'),
      'attestation invocation',
    ),
  };
}

function normalizeAttestation(
  value: unknown,
  expectedInvocation: string,
): GitHubAttestationEvidence {
  const matching = array(value, 'attestation verification')
    .map(normalizeAttestationResult)
    .filter((attestation) => attestation.invocation === expectedInvocation);
  invariant(
    matching.length === 1,
    'GITHUB_EVIDENCE_INVALID',
    `Expected one attestation for ${expectedInvocation}, received ${matching.length}`,
  );
  return matching[0]!;
}

function workflowRef(run: JsonObject, subjectRef: string, event: string): string {
  if (event === 'pull_request') {
    return subjectRef;
  }
  const branch = string(property(run, 'head_branch', 'workflow run'), 'workflow branch');
  return `refs/heads/${branch}`;
}

export function collectGitHubEvidence(
  options: CollectGitHubEvidenceOptions,
  runner = createGitHubCliRunner(options.repoRoot),
): GitHubEvidence {
  const { anchor, run } = options;
  const runId = Number(run.runId);
  invariant(
    Number.isInteger(runId) && runId > 0,
    'GITHUB_EVIDENCE_INVALID',
    'A GitHub observation requires a numeric runId',
  );

  const workflow = object(
    api(runner, `repos/${anchor.repository}/actions/runs/${runId}`),
    'workflow run',
  );
  const jobsResponse = object(
    api(runner, `repos/${anchor.repository}/actions/runs/${runId}/jobs`),
    'workflow jobs',
  );
  const jobs = array(property(jobsResponse, 'jobs', 'workflow jobs'), 'workflow jobs');
  const matchingJobs = jobs
    .map((job) => object(job, 'workflow job'))
    .filter((job) => job.name === anchor.jobName);
  invariant(
    matchingJobs.length === 1,
    'GITHUB_EVIDENCE_INVALID',
    `Expected one ${anchor.jobName} job, received ${matchingJobs.length}`,
  );
  const job = matchingJobs[0]!;
  const jobId = number(property(job, 'id', 'workflow job'), 'workflow job id');
  const checkRun = object(
    api(runner, `repos/${anchor.repository}/check-runs/${jobId}`),
    'check run',
  );
  const checkApp = object(property(checkRun, 'app', 'check run'), 'check app');
  const repository = object(
    property(workflow, 'repository', 'workflow run'),
    'workflow repository',
  );
  const runnerGroup = nullableString(job.runner_group_name ?? null, 'runner group');
  const attempt = number(
    property(workflow, 'run_attempt', 'workflow run'),
    'workflow run attempt',
  );

  let pullRequest: GitHubPullRequestEvidence | null = null;
  const signatures = [
    normalizeSignature(
      api(runner, `repos/${anchor.repository}/commits/${run.subject.commit}`),
    ),
  ];

  if (run.subject.pullRequest !== null) {
    const pullNumber = run.subject.pullRequest.number;
    const pullRequestResponse = api(
      runner,
      `repos/${anchor.repository}/pulls/${pullNumber}`,
    );
    const rawPullRequest = object(pullRequestResponse, 'pull request');
    pullRequest = normalizePullRequest(rawPullRequest);
    const pullCommits = pagedApi(
      runner,
      `repos/${anchor.repository}/pulls/${pullNumber}/commits?per_page=100`,
    );
    const pullSignatures = pullCommits.map(normalizeSignature);
    const expectedCommitCount = number(
      property(rawPullRequest, 'commits', 'pull request'),
      'pull request commit count',
    );
    invariant(
      pullSignatures.length === expectedCommitCount,
      'GITHUB_EVIDENCE_INVALID',
      `Expected ${expectedCommitCount} pull request commits, received ${pullSignatures.length}`,
    );
    pullRequest.commits = pullSignatures.map((signature) => signature.commit);
    for (const signature of pullSignatures) {
      if (!signatures.some((candidate) => candidate.commit === signature.commit)) {
        signatures.push(signature);
      }
    }
  }

  const rulesetSummaries = pagedApi(
    runner,
    `repos/${anchor.repository}/rulesets?includes_parents=true&per_page=100`,
  );
  const rulesets = rulesetSummaries
    .map((summary) => object(summary, 'ruleset summary'))
    .map((summary) => number(property(summary, 'id', 'ruleset summary'), 'ruleset id'))
    .map((id) =>
      normalizeRuleset(api(runner, `repos/${anchor.repository}/rulesets/${id}`)),
    )
    .sort((left, right) => left.id - right.id);

  const absoluteRunPath = resolve(options.repoRoot, options.runPath);
  const runFileHash = sha256(readFileSync(absoluteRunPath));
  let attestation: GitHubAttestationEvidence | null = null;

  if (run.subject.event === 'push' && run.subject.ref === anchor.protectedRef) {
    attestation = normalizeAttestation(
      parseJson(
        runner.run([
          'attestation',
          'verify',
          absoluteRunPath,
          '--repo',
          anchor.repository,
          '--signer-workflow',
          `${anchor.repository}/${anchor.workflowPath}`,
          '--source-ref',
          run.subject.ref,
          '--source-digest',
          run.subject.commit,
          '--deny-self-hosted-runners',
          '--format',
          'json',
        ]),
        'gh attestation verify',
      ),
      `https://github.com/${anchor.repository}/actions/runs/${runId}/attempts/${attempt}`,
    );
  }

  return {
    schemaVersion: GITHUB_EVIDENCE_SCHEMA_VERSION,
    observedAt: options.observedAt ?? new Date().toISOString(),
    trustAnchor: anchor.id,
    runFileHash,
    subject: run.subject,
    workflow: {
      runId: number(property(workflow, 'id', 'workflow run'), 'workflow run id'),
      attempt,
      repository: string(
        property(repository, 'full_name', 'workflow repository'),
        'workflow repository name',
      ),
      commit: string(property(workflow, 'head_sha', 'workflow run'), 'workflow commit'),
      ref: workflowRef(workflow, run.subject.ref, run.subject.event),
      event: string(property(workflow, 'event', 'workflow run'), 'workflow event'),
      workflowPath: string(
        property(workflow, 'path', 'workflow run'),
        'workflow path',
      ),
      status: string(property(workflow, 'status', 'workflow run'), 'workflow status'),
      conclusion: nullableString(workflow.conclusion ?? null, 'workflow conclusion'),
      url: string(property(workflow, 'html_url', 'workflow run'), 'workflow URL'),
      job: {
        id: jobId,
        name: string(property(job, 'name', 'workflow job'), 'workflow job name'),
        checkName: string(
          property(checkRun, 'name', 'check run'),
          'workflow check name',
        ),
        checkAppId: number(property(checkApp, 'id', 'check app'), 'check app id'),
        checkAppSlug: string(
          property(checkApp, 'slug', 'check app'),
          'check app slug',
        ),
        status: string(property(job, 'status', 'workflow job'), 'workflow job status'),
        conclusion: nullableString(job.conclusion ?? null, 'workflow job conclusion'),
        runnerEnvironment:
          runnerGroup === 'GitHub Actions' ? 'github-hosted' : 'self-hosted',
        url: string(property(job, 'html_url', 'workflow job'), 'workflow job URL'),
      },
    },
    pullRequest,
    signatures: signatures.sort((left, right) =>
      left.commit.localeCompare(right.commit),
    ),
    attestation,
    rulesets: {
      contentHash: canonicalHash(rulesets),
      items: rulesets,
    },
  };
}

function invalidObservation(
  runObservation: ReturnType<typeof observeRun>,
  evidence: GitHubEvidence,
  reasons: string[],
): GitHubObservation {
  const reason = reasons.join(' ');
  return {
    state: 'invalid',
    reason,
    ready: false,
    activationReady: false,
    blockers: reasons,
    activationBlockers: reasons,
    run: runObservation,
    evidence,
  };
}

function appliesToRef(ruleset: GitHubRulesetEvidence, ref: string): boolean {
  if (ruleset.target !== 'branch' || ruleset.enforcement !== 'active') {
    return false;
  }
  const refName = ruleset.conditions?.ref_name;
  if (refName === undefined || refName === null) {
    return true;
  }
  const condition = object(refName, 'ruleset ref_name condition');
  const include = Array.isArray(condition.include)
    ? condition.include.filter((item): item is string => typeof item === 'string')
    : [];
  const exclude = Array.isArray(condition.exclude)
    ? condition.exclude.filter((item): item is string => typeof item === 'string')
    : [];
  const matches = (pattern: string): boolean =>
    pattern === '~ALL' || pattern === '~DEFAULT_BRANCH' || pattern === ref;
  return include.some(matches) && !exclude.some(matches);
}

function rulesetActivationBlockers(
  anchor: GitHubTrustAnchor,
  evidence: GitHubEvidence,
): string[] {
  const rulesets = evidence.rulesets.items.filter((ruleset) =>
    appliesToRef(ruleset, anchor.protectedRef),
  );
  const rules = rulesets.flatMap((ruleset) => ruleset.rules);
  const blockers: string[] = [];

  if (
    !anchor.ruleset.allowBypassActors &&
    rulesets.some((ruleset) => ruleset.bypassActors.length > 0)
  ) {
    blockers.push('One or more applicable rulesets allow bypass actors.');
  }

  for (const required of anchor.ruleset.requiredRules) {
    if (!rules.some((rule) => rule.type === required)) {
      blockers.push(`Ruleset rule ${required} is not active for ${anchor.protectedRef}.`);
    }
  }

  const statusChecks = rules
    .filter((rule) => rule.type === 'required_status_checks')
    .flatMap((rule) => {
      const checks = rule.parameters?.required_status_checks;
      if (!Array.isArray(checks)) {
        return [];
      }
      return checks.flatMap((check) => {
        if (check === null || typeof check !== 'object' || Array.isArray(check)) {
          return [];
        }
        const record = check as Record<string, unknown>;
        const context = record.context;
        const integrationId = record.integration_id;
        return typeof context === 'string' && typeof integrationId === 'number'
          ? [{ context, integrationId }]
          : [];
      });
    });

  for (const context of anchor.ruleset.requiredStatusChecks) {
    if (
      !statusChecks.some(
        (check) =>
          check.context === context && check.integrationId === anchor.checkAppId,
      )
    ) {
      blockers.push(
        `Required status check ${context} is not bound to ${anchor.checkAppSlug}.`,
      );
    }
  }

  const pullRequestRules = rules.filter((rule) => rule.type === 'pull_request');
  if (anchor.ruleset.requireReviewThreadResolution) {
    const resolvesThreads = pullRequestRules.some(
      (rule) => rule.parameters?.required_review_thread_resolution === true,
    );
    if (!resolvesThreads) {
      blockers.push('Pull request review-thread resolution is not required.');
    }
  }

  const approvalCounts = pullRequestRules.map((rule) => {
    const count = rule.parameters?.required_approving_review_count;
    return typeof count === 'number' ? count : 0;
  });
  if (
    anchor.ruleset.minimumApprovals > 0 &&
    (approvalCounts.length === 0 ||
      Math.max(...approvalCounts) < anchor.ruleset.minimumApprovals)
  ) {
    blockers.push(
      `Pull requests require fewer than ${anchor.ruleset.minimumApprovals} approvals.`,
    );
  }

  return blockers;
}

export function verifyGitHubEvidence(
  plan: GovernancePlan,
  manifest: GovernanceManifest,
  run: GovernanceRun,
  evidence: GitHubEvidence,
  anchor: GitHubTrustAnchor,
  actualRunFileHash: string,
): GitHubObservation {
  const runObservation = observeRun(plan, manifest, run, evidence.subject);
  if (runObservation.state !== 'current') {
    return {
      state: runObservation.state,
      reason: runObservation.reason,
      ready: false,
      activationReady: false,
      blockers: runObservation.blockers,
      activationBlockers: runObservation.blockers,
      run: runObservation,
      evidence,
    };
  }

  const reasons: string[] = [];
  const expectedRunId = Number(run.runId);
  const expectedSigner = `https://github.com/${anchor.repository}/${anchor.workflowPath}@${run.subject.ref}`;
  const expectedRepository = `https://github.com/${anchor.repository}`;
  const expectedInvocation = `https://github.com/${anchor.repository}/actions/runs/${run.runId}/attempts/${evidence.workflow.attempt}`;

  if (evidence.trustAnchor !== anchor.id) {
    reasons.push(`Evidence names trust anchor ${evidence.trustAnchor}, not ${anchor.id}.`);
  }
  if (evidence.runFileHash !== actualRunFileHash) {
    reasons.push('The observed run file hash differs from the supplied run file.');
  }
  if (evidence.subject.repository !== anchor.repository) {
    reasons.push(`Evidence repository is not ${anchor.repository}.`);
  }
  if (
    evidence.workflow.runId !== expectedRunId ||
    evidence.workflow.repository !== anchor.repository ||
    evidence.workflow.commit !== run.subject.commit ||
    evidence.workflow.ref !== run.subject.ref ||
    evidence.workflow.event !== run.subject.event
  ) {
    reasons.push('The workflow run does not match the exact execution subject.');
  }
  if (evidence.workflow.workflowPath !== anchor.workflowPath) {
    reasons.push(`The workflow path is not ${anchor.workflowPath}.`);
  }
  if (
    (evidence.workflow.conclusion !== null &&
      evidence.workflow.conclusion !== 'success') ||
    evidence.workflow.job.status !== 'completed' ||
    evidence.workflow.job.conclusion !== 'success'
  ) {
    reasons.push('The workflow failed or the required job did not complete successfully.');
  }
  if (
    evidence.workflow.job.name !== anchor.jobName ||
    evidence.workflow.job.checkName !== anchor.checkName ||
    evidence.workflow.job.checkAppId !== anchor.checkAppId ||
    evidence.workflow.job.checkAppSlug !== anchor.checkAppSlug
  ) {
    reasons.push('The observed job, check, or check app differs from the trust anchor.');
  }
  if (evidence.workflow.job.runnerEnvironment !== anchor.runnerEnvironment) {
    reasons.push('The required job did not run on a GitHub-hosted runner.');
  }

  if (
    canonicalJson(evidence.pullRequest) !== canonicalJson(run.subject.pullRequest)
  ) {
    const normalizedPullRequest =
      evidence.pullRequest === null
        ? null
        : {
            number: evidence.pullRequest.number,
            headCommit: evidence.pullRequest.headCommit,
            headRef: evidence.pullRequest.headRef,
            baseCommit: evidence.pullRequest.baseCommit,
            baseRef: evidence.pullRequest.baseRef,
          };
    if (
      canonicalJson(normalizedPullRequest) !== canonicalJson(run.subject.pullRequest)
    ) {
      reasons.push('The pull request number, head, or base differs from the run subject.');
    }
  }

  const signatureCommits = new Set(
    evidence.signatures.map((signature) => signature.commit),
  );
  if (!signatureCommits.has(run.subject.commit)) {
    reasons.push('No signature observation exists for the workflow commit.');
  }
  if (
    run.subject.pullRequest !== null &&
    !signatureCommits.has(run.subject.pullRequest.headCommit)
  ) {
    reasons.push('No signature observation exists for the pull request head commit.');
  }
  if (
    evidence.pullRequest !== null &&
    evidence.pullRequest.commits.some((commit) => !signatureCommits.has(commit))
  ) {
    reasons.push('One or more pull request commits have no signature observation.');
  }
  if (
    evidence.pullRequest !== null &&
    new Set(evidence.pullRequest.commits).size !== evidence.pullRequest.commits.length
  ) {
    reasons.push('The pull request commit list contains duplicates.');
  }
  if (new Set(evidence.signatures.map((item) => item.commit)).size !== evidence.signatures.length) {
    reasons.push('The evidence contains duplicate commit signature observations.');
  }

  if (evidence.rulesets.contentHash !== canonicalHash(evidence.rulesets.items)) {
    reasons.push('The ruleset snapshot hash is invalid.');
  }

  const attestationRequired =
    run.subject.event === 'push' && run.subject.ref === anchor.protectedRef;
  if (attestationRequired && evidence.attestation === null) {
    reasons.push('Protected-branch evidence has no provenance attestation.');
  }
  if (!attestationRequired && evidence.attestation !== null) {
    reasons.push('An attestation was attached to an execution where it is not expected.');
  }

  const attestation = evidence.attestation;
  if (
    attestation !== null &&
    (attestation.subjectName !== basename('governance-run.json') ||
      attestation.subjectDigest !== actualRunFileHash ||
      attestation.signerWorkflow !== expectedSigner ||
      attestation.sourceRepository !== expectedRepository ||
      attestation.sourceCommit !== run.subject.commit ||
      attestation.sourceRef !== run.subject.ref ||
      attestation.oidcIssuer !== anchor.oidcIssuer ||
      attestation.runnerEnvironment !== anchor.runnerEnvironment ||
      attestation.event !== run.subject.event ||
      attestation.invocation !== expectedInvocation)
  ) {
    reasons.push('The provenance attestation does not match the trusted execution.');
  }

  if (reasons.length > 0) {
    return invalidObservation(runObservation, evidence, reasons);
  }

  const activationBlockers = [
    ...evidence.signatures
      .filter((signature) => !signature.verified || signature.reason !== 'valid')
      .map(
        (signature) =>
          `Commit ${signature.commit} is not GitHub-verified (${signature.reason}).`,
      ),
    ...rulesetActivationBlockers(anchor, evidence),
  ];
  const ready = runObservation.ready;

  return {
    state: 'current',
    reason: null,
    ready,
    activationReady: ready && activationBlockers.length === 0,
    blockers: runObservation.blockers,
    activationBlockers,
    run: runObservation,
    evidence,
  };
}
