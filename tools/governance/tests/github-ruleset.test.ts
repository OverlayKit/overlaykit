import { describe, expect, it } from 'vitest';
import { canonicalHash, canonicalJson } from '../src/canonical.js';
import { compileGovernance } from '../src/compiler.js';
import { normalizeGitHubRuleset, type GitHubCommandRunner } from '../src/github-observer.js';
import {
  assertGitHubRulesetActivationAuthorization,
  buildGitHubRulesetPayload,
  buildGitHubRulesetPlan,
  createGitHubRuleset,
  readGitHubRefCommit,
} from '../src/github-ruleset.js';
import { buildManifest } from '../src/manifest.js';
import { findRepoRoot, loadContract } from '../src/repository.js';
import type {
  GitHubObservation,
  GitHubTrustAnchor,
  GovernanceRun,
} from '../src/types.js';

const root = findRepoRoot();
const contract = loadContract(root);
const governancePlan = compileGovernance(contract);
const manifest = buildManifest(contract, governancePlan);
const anchor = governancePlan.trustAnchors.find(
  (candidate): candidate is GitHubTrustAnchor => candidate.kind === 'github',
)!;

function apiResponse() {
  const payload = buildGitHubRulesetPayload(anchor);
  return {
    id: 42,
    name: payload.name,
    target: payload.target,
    enforcement: payload.enforcement,
    source: anchor.repository,
    source_type: 'Repository',
    conditions: payload.conditions,
    bypass_actors: payload.bypass_actors,
    rules: payload.rules,
  };
}

function authorizationOptions() {
  const activationPlan = buildGitHubRulesetPlan(
    contract,
    governancePlan,
    manifest,
    anchor,
  );
  const commit = 'a'.repeat(40);
  const run = {
    runId: '42',
    subject: {
      repository: anchor.repository,
      commit,
      ref: anchor.protectedRef,
      event: 'push',
      pullRequest: null,
    },
  } as GovernanceRun;
  const observation = {
    state: 'current',
    reason: null,
    ready: true,
    activationReady: false,
    blockers: [],
    activationBlockers: ['Ruleset is absent.'],
  } as unknown as GitHubObservation;
  return {
    activationPlan,
    anchor,
    run,
    observation,
    confirmedPlanHash: activationPlan.planHash,
    confirmedPayloadHash: activationPlan.payloadHash,
    localRef: anchor.protectedRef,
    localCommit: commit,
    remoteCommit: commit,
  };
}

describe('GitHub ruleset controller', () => {
  it('derives a canonical create payload from the compiled trust anchor', () => {
    const first = buildGitHubRulesetPlan(
      contract,
      governancePlan,
      manifest,
      anchor,
    );
    const second = buildGitHubRulesetPlan(
      contract,
      governancePlan,
      manifest,
      anchor,
    );

    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first.authorizationChange).toBe('CHG-0003');
    expect(first.planHash).toBe(governancePlan.planHash);
    expect(first.manifestHash).toBe(manifest.contentHash);
    expect(first.payloadHash).toBe(canonicalHash(first.payload));
    expect(first.payload).toMatchObject({
      name: 'main',
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [],
      conditions: {
        ref_name: { include: ['refs/heads/main'], exclude: [] },
      },
    });
    expect(first.payload.rules.map((rule) => rule.type)).toEqual([
      'deletion',
      'non_fast_forward',
      'pull_request',
      'required_signatures',
      'required_status_checks',
    ]);
  });

  it('creates exactly the planned ruleset through a JSON stdin payload', () => {
    const activationPlan = buildGitHubRulesetPlan(
      contract,
      governancePlan,
      manifest,
      anchor,
    );
    let observedArgs: string[] = [];
    let observedInput: string | undefined;
    const runner: GitHubCommandRunner = {
      run(args, input) {
        observedArgs = args;
        observedInput = input;
        return JSON.stringify(apiResponse());
      },
    };

    const created = createGitHubRuleset(activationPlan, anchor, [], runner);

    expect(created.id).toBe(42);
    expect(observedArgs).toEqual([
      'api',
      '--method',
      'POST',
      `repos/${anchor.repository}/rulesets`,
      '--input',
      '-',
    ]);
    expect(observedInput).toBe(canonicalJson(activationPlan.payload));
  });

  it('authorizes only an affirmed attested protected-main execution', () => {
    expect(() =>
      assertGitHubRulesetActivationAuthorization(authorizationOptions()),
    ).not.toThrow();

    expect(() =>
      assertGitHubRulesetActivationAuthorization({
        ...authorizationOptions(),
        confirmedPlanHash: 'f'.repeat(64),
      }),
    ).toThrow('confirmed plan hash differs');

    expect(() =>
      assertGitHubRulesetActivationAuthorization({
        ...authorizationOptions(),
        localRef: 'refs/heads/feature',
      }),
    ).toThrow('Local HEAD must be the attested protected-main commit');

    expect(() =>
      assertGitHubRulesetActivationAuthorization({
        ...authorizationOptions(),
        remoteCommit: 'b'.repeat(40),
      }),
    ).toThrow('live GitHub protected ref differs');
  });

  it('refuses to update or adopt an existing managed ruleset', () => {
    const activationPlan = buildGitHubRulesetPlan(
      contract,
      governancePlan,
      manifest,
      anchor,
    );
    const existing = normalizeGitHubRuleset(apiResponse());
    const runner: GitHubCommandRunner = {
      run() {
        throw new Error('mutation must not be attempted');
      },
    };

    expect(() =>
      createGitHubRuleset(activationPlan, anchor, [existing], runner),
    ).toThrow('create-only');
  });

  it('refuses an unconfigured ruleset that already applies to main', () => {
    const activationPlan = buildGitHubRulesetPlan(
      contract,
      governancePlan,
      manifest,
      anchor,
    );
    const response = apiResponse();
    response.name = 'manual';
    const existing = normalizeGitHubRuleset(response);
    const runner: GitHubCommandRunner = {
      run() {
        throw new Error('mutation must not be attempted');
      },
    };

    expect(() =>
      createGitHubRuleset(activationPlan, anchor, [existing], runner),
    ).toThrow(`already applies to ${anchor.protectedRef}`);
  });

  it('rejects a payload modified after compilation', () => {
    const activationPlan = buildGitHubRulesetPlan(
      contract,
      governancePlan,
      manifest,
      anchor,
    );
    activationPlan.payload.name = 'tampered';
    const runner: GitHubCommandRunner = {
      run() {
        throw new Error('mutation must not be attempted');
      },
    };

    expect(() => createGitHubRuleset(activationPlan, anchor, [], runner)).toThrow(
      'differs from the compiled trust anchor',
    );
  });

  it('reads the exact protected ref commit from GitHub', () => {
    const commit = 'a'.repeat(40);
    const runner: GitHubCommandRunner = {
      run(args) {
        expect(args).toEqual([
          'api',
          `repos/${anchor.repository}/git/ref/heads/main`,
        ]);
        return JSON.stringify({ object: { sha: commit } });
      },
    };

    expect(readGitHubRefCommit(anchor, runner)).toBe(commit);
  });
});
