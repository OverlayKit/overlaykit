import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalHash } from '../src/canonical.js';
import { compileGovernance } from '../src/compiler.js';
import {
  collectGitHubEvidence,
  verifyGitHubEvidence,
  type GitHubCommandRunner,
} from '../src/github-observer.js';
import { buildManifest } from '../src/manifest.js';
import {
  findRepoRoot,
  loadContract,
  validateGitHubEvidence,
} from '../src/repository.js';
import {
  GITHUB_EVIDENCE_SCHEMA_VERSION,
  RUN_SCHEMA_VERSION,
  type GitHubEvidence,
  type GovernanceRun,
} from '../src/types.js';

const root = findRepoRoot();
const contract = loadContract(root);
const plan = compileGovernance(contract);
const manifest = buildManifest(contract, plan);
const anchor = plan.trustAnchors[0]!;
const runFileHash = 'd'.repeat(64);

function pullRequestRun(): GovernanceRun {
  const subject = {
    repository: anchor.repository,
    commit: 'a'.repeat(40),
    ref: 'refs/pull/2/merge',
    event: 'pull_request',
    pullRequest: {
      number: 2,
      headCommit: 'b'.repeat(40),
      headRef: 'codex/github-root-of-trust',
      baseCommit: 'c'.repeat(40),
      baseRef: 'main',
    },
  };

  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: '42',
    profileHash: plan.profileHash,
    planHash: plan.planHash,
    manifestHash: manifest.contentHash,
    invokedBy: {
      kind: 'ci',
      id: 'github-actions',
      principal: '@rodrigoteamx',
    },
    producer: {
      kind: 'github-actions',
      id: anchor.workflowPath,
      version: `${anchor.repository}/${anchor.workflowPath}@${subject.ref}`,
      commit: subject.commit,
    },
    subject,
    source: 'ci',
    startedAt: '2026-07-20T20:00:00.000Z',
    finishedAt: '2026-07-20T20:01:00.000Z',
    assumptions: plan.assumptions,
    outcomes: plan.gates.map((gate) => ({
      gate: gate.id,
      outcome: gate.tier === 'enforced' ? 'passed' : 'pending',
      producerRef:
        gate.tier === 'enforced'
          ? `https://github.com/${anchor.repository}/actions/runs/42`
          : null,
      justification: null,
      boundTo: gate.boundTo,
    })),
    artifacts: plan.artifacts
      .filter((artifact) => artifact.tier === 'enforced')
      .map((artifact) => ({
        artifact: artifact.id,
        producerRef: `https://github.com/${anchor.repository}/actions/runs/42`,
        contentHash: artifact.id === 'governance-plan' ? plan.planHash : null,
      })),
  };
}

function activeRulesets(): GitHubEvidence['rulesets']['items'] {
  return [
    {
      id: 1,
      name: 'main',
      target: 'branch',
      enforcement: 'active',
      source: anchor.repository,
      sourceType: 'Repository',
      conditions: {
        ref_name: {
          include: ['~DEFAULT_BRANCH'],
          exclude: [],
        },
      },
      bypassActors: [],
      rules: [
        { type: 'deletion', parameters: null },
        { type: 'non_fast_forward', parameters: null },
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 0,
            required_review_thread_resolution: true,
          },
        },
        { type: 'required_signatures', parameters: null },
        {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: [
              {
                context: anchor.checkName,
                integration_id: anchor.checkAppId,
              },
            ],
          },
        },
      ],
    },
  ];
}

function evidence(run: GovernanceRun): GitHubEvidence {
  const rulesets = activeRulesets();
  const pullRequest = run.subject.pullRequest;

  return {
    schemaVersion: GITHUB_EVIDENCE_SCHEMA_VERSION,
    observedAt: '2026-07-20T20:02:00.000Z',
    trustAnchor: anchor.id,
    runFileHash,
    subject: run.subject,
    workflow: {
      runId: Number(run.runId),
      attempt: 1,
      repository: anchor.repository,
      commit: run.subject.commit,
      ref: run.subject.ref,
      event: run.subject.event,
      workflowPath: anchor.workflowPath,
      status: 'in_progress',
      conclusion: null,
      url: `https://github.com/${anchor.repository}/actions/runs/${run.runId}`,
      job: {
        id: 84,
        name: anchor.jobName,
        checkName: anchor.checkName,
        checkAppId: anchor.checkAppId,
        checkAppSlug: anchor.checkAppSlug,
        status: 'completed',
        conclusion: 'success',
        runnerEnvironment: anchor.runnerEnvironment,
        url: `https://github.com/${anchor.repository}/actions/runs/${run.runId}/job/84`,
      },
    },
    pullRequest:
      pullRequest === null
        ? null
        : {
            ...pullRequest,
            state: 'open',
            commits: [pullRequest.headCommit],
          },
    signatures: [
      {
        commit: run.subject.commit,
        verified: true,
        reason: 'valid',
        verifiedAt: '2026-07-20T20:00:00.000Z',
      },
      ...(pullRequest === null
        ? []
        : [
            {
              commit: pullRequest.headCommit,
              verified: true,
              reason: 'valid',
              verifiedAt: '2026-07-20T20:00:00.000Z',
            },
          ]),
    ],
    attestation: null,
    rulesets: {
      contentHash: canonicalHash(rulesets),
      items: rulesets,
    },
  };
}

function protectedPushRun(): GovernanceRun {
  const run = pullRequestRun();
  run.subject = {
    repository: anchor.repository,
    commit: 'e'.repeat(40),
    ref: anchor.protectedRef,
    event: 'push',
    pullRequest: null,
  };
  run.producer.commit = run.subject.commit;
  run.producer.version = `${anchor.repository}/${anchor.workflowPath}@${anchor.protectedRef}`;
  return run;
}

describe('GitHub root of trust observer', () => {
  it('collects normalized GitHub API evidence through an injected adapter', () => {
    const run = pullRequestRun();
    const directory = mkdtempSync(join(tmpdir(), 'overlaykit-governance-'));
    const runPath = join(directory, 'governance-run.json');
    writeFileSync(runPath, JSON.stringify(run));
    const commitResponse = (commit: string) => ({
      sha: commit,
      commit: {
        verification: {
          verified: true,
          reason: 'valid',
          verified_at: '2026-07-20T20:00:00.000Z',
        },
      },
    });
    const responses = new Map<string, unknown>([
      [
        `api repos/${anchor.repository}/actions/runs/${run.runId}`,
        {
          id: Number(run.runId),
          head_branch: run.subject.pullRequest!.headRef,
          head_sha: run.subject.commit,
          path: anchor.workflowPath,
          event: run.subject.event,
          status: 'in_progress',
          conclusion: null,
          run_attempt: 1,
          html_url: `https://github.com/${anchor.repository}/actions/runs/${run.runId}`,
          repository: { full_name: anchor.repository },
        },
      ],
      [
        `api repos/${anchor.repository}/actions/runs/${run.runId}/jobs`,
        {
          jobs: [
            {
              id: 84,
              name: anchor.jobName,
              status: 'completed',
              conclusion: 'success',
              runner_group_name: 'GitHub Actions',
              html_url: `https://github.com/${anchor.repository}/actions/runs/${run.runId}/job/84`,
            },
          ],
        },
      ],
      [
        `api repos/${anchor.repository}/check-runs/84`,
        {
          name: anchor.checkName,
          app: {
            id: anchor.checkAppId,
            slug: anchor.checkAppSlug,
          },
        },
      ],
      [
        `api repos/${anchor.repository}/commits/${run.subject.commit}`,
        commitResponse(run.subject.commit),
      ],
      [
        `api repos/${anchor.repository}/pulls/${run.subject.pullRequest!.number}`,
        {
          number: run.subject.pullRequest!.number,
          state: 'open',
          commits: 1,
          head: {
            sha: run.subject.pullRequest!.headCommit,
            ref: run.subject.pullRequest!.headRef,
          },
          base: {
            sha: run.subject.pullRequest!.baseCommit,
            ref: run.subject.pullRequest!.baseRef,
          },
        },
      ],
      [
        `api --paginate --slurp repos/${anchor.repository}/pulls/${run.subject.pullRequest!.number}/commits?per_page=100`,
        [[commitResponse(run.subject.pullRequest!.headCommit)]],
      ],
      [
        `api --paginate --slurp repos/${anchor.repository}/rulesets?includes_parents=true&per_page=100`,
        [[]],
      ],
    ]);
    const runner: GitHubCommandRunner = {
      run(args) {
        const key = args.join(' ');
        const response = responses.get(key);
        if (response === undefined) {
          throw new Error(`Unexpected gh invocation: ${key}`);
        }
        return JSON.stringify(response);
      },
    };

    try {
      const observed = collectGitHubEvidence(
        {
          repoRoot: root,
          runPath,
          run,
          anchor,
          observedAt: '2026-07-20T20:02:00.000Z',
        },
        runner,
      );
      validateGitHubEvidence(root, observed);

      expect(observed.subject).toEqual(run.subject);
      expect(observed.workflow.job.runnerEnvironment).toBe('github-hosted');
      expect(observed.signatures.map((item) => item.commit)).toEqual([
        run.subject.commit,
        run.subject.pullRequest!.headCommit,
      ]);
      expect(observed.rulesets).toEqual({
        contentHash: canonicalHash([]),
        items: [],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('accepts evidence bound to the exact PR, workflow, check, signatures, and ruleset', () => {
    const run = pullRequestRun();
    const observation = verifyGitHubEvidence(
      plan,
      manifest,
      run,
      evidence(run),
      anchor,
      runFileHash,
    );

    expect(observation.state).toBe('current');
    expect(observation.ready).toBe(true);
    expect(observation.activationReady).toBe(true);
    expect(observation.activationBlockers).toEqual([]);
  });

  it('rejects evidence from another workflow commit', () => {
    const run = pullRequestRun();
    const observed = evidence(run);
    observed.workflow.commit = 'f'.repeat(40);
    const observation = verifyGitHubEvidence(
      plan,
      manifest,
      run,
      observed,
      anchor,
      runFileHash,
    );

    expect(observation.state).toBe('invalid');
    expect(observation.reason).toContain('exact execution subject');
  });

  it('rejects evidence produced by another workflow path', () => {
    const run = pullRequestRun();
    const observed = evidence(run);
    observed.workflow.workflowPath = '.github/workflows/other.yml';
    const observation = verifyGitHubEvidence(
      plan,
      manifest,
      run,
      observed,
      anchor,
      runFileHash,
    );

    expect(observation.state).toBe('invalid');
    expect(observation.reason).toContain('workflow path');
  });

  it('rejects a PR observation with a different head', () => {
    const run = pullRequestRun();
    const observed = evidence(run);
    observed.pullRequest!.headCommit = 'f'.repeat(40);
    const observation = verifyGitHubEvidence(
      plan,
      manifest,
      run,
      observed,
      anchor,
      runFileHash,
    );

    expect(observation.state).toBe('invalid');
    expect(observation.reason).toContain('pull request number, head, or base');
  });

  it('rejects a modified ruleset snapshot', () => {
    const run = pullRequestRun();
    const observed = evidence(run);
    observed.rulesets.items[0]!.name = 'tampered';
    const observation = verifyGitHubEvidence(
      plan,
      manifest,
      run,
      observed,
      anchor,
      runFileHash,
    );

    expect(observation.state).toBe('invalid');
    expect(observation.reason).toContain('ruleset snapshot hash');
  });

  it('reports missing rules as activation blockers without fabricating enforcement', () => {
    const run = pullRequestRun();
    const observed = evidence(run);
    observed.rulesets = { contentHash: canonicalHash([]), items: [] };
    const observation = verifyGitHubEvidence(
      plan,
      manifest,
      run,
      observed,
      anchor,
      runFileHash,
    );

    expect(observation.state).toBe('current');
    expect(observation.ready).toBe(true);
    expect(observation.activationReady).toBe(false);
    expect(observation.activationBlockers).toContain(
      `Ruleset rule required_signatures is not active for ${anchor.protectedRef}.`,
    );
  });

  it('requires protected-main evidence to carry an exact provenance attestation', () => {
    const run = protectedPushRun();
    const observed = evidence(run);
    observed.attestation = {
      subjectName: 'governance-run.json',
      subjectDigest: runFileHash,
      signerWorkflow: `https://github.com/${anchor.repository}/${anchor.workflowPath}@${anchor.protectedRef}`,
      sourceRepository: `https://github.com/${anchor.repository}`,
      sourceCommit: run.subject.commit,
      sourceRef: anchor.protectedRef,
      oidcIssuer: anchor.oidcIssuer,
      runnerEnvironment: anchor.runnerEnvironment,
      event: 'push',
      invocation: `https://github.com/${anchor.repository}/actions/runs/${run.runId}/attempts/1`,
    };

    const valid = verifyGitHubEvidence(
      plan,
      manifest,
      run,
      observed,
      anchor,
      runFileHash,
    );
    expect(valid.state).toBe('current');

    observed.attestation.sourceCommit = 'f'.repeat(40);
    const invalid = verifyGitHubEvidence(
      plan,
      manifest,
      run,
      observed,
      anchor,
      runFileHash,
    );
    expect(invalid.state).toBe('invalid');
    expect(invalid.reason).toContain('provenance attestation');
  });

  it('rejects a trusted job reported from a self-hosted runner', () => {
    const run = pullRequestRun();
    const observed = evidence(run);
    observed.workflow.job.runnerEnvironment = 'self-hosted';
    const observation = verifyGitHubEvidence(
      plan,
      manifest,
      run,
      observed,
      anchor,
      runFileHash,
    );

    expect(observation.state).toBe('invalid');
    expect(observation.reason).toContain('GitHub-hosted runner');
  });
});
