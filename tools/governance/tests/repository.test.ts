import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/canonical.js';
import { compileGovernance } from '../src/compiler.js';
import { buildManifest } from '../src/manifest.js';
import {
  findRepoRoot,
  loadContract,
  verifyMechanismBindings,
  verifyPinnedWorkflowActions,
} from '../src/repository.js';

describe('OverlayKit governance contract', () => {
  it('loads, binds to real mechanisms, and matches generated artifacts', () => {
    const root = findRepoRoot();
    const contract = loadContract(root);

    verifyMechanismBindings(root, contract.mechanisms);
    verifyPinnedWorkflowActions(root);

    const plan = compileGovernance(contract);
    const manifest = buildManifest(contract, plan);
    expect(plan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'ADR-0001',
          effectiveStatus: 'superseded',
          supersededBy: 'ADR-0002',
        }),
        expect.objectContaining({
          id: 'ADR-0002',
          effectiveStatus: 'superseded',
          supersededBy: 'ADR-0003',
        }),
        expect.objectContaining({
          id: 'ADR-0003',
          effectiveStatus: 'accepted',
          supersededBy: null,
        }),
        expect.objectContaining({
          id: 'ADR-0004',
          effectiveStatus: 'accepted',
          supersededBy: null,
        }),
      ]),
    );
    expect(plan.gates.find((gate) => gate.id === 'signed-identity')).toEqual(
      expect.objectContaining({
        tier: 'enforced',
        boundTo: 'ci:signed-identity',
        sourceDecision: 'ADR-0003',
      }),
    );
    expect(plan.gates.find((gate) => gate.id === 'independent-review')).toEqual(
      expect.objectContaining({
        tier: 'deferred',
        sourceDecision: 'ADR-0003',
      }),
    );
    expect(plan.specifications).toEqual([
      expect.objectContaining({
        id: 'SPEC-0001',
        effectiveStatus: 'accepted',
        userStoryIds: expect.arrayContaining(['US-001', 'US-010']),
      }),
    ]);
    const storedPlan = JSON.parse(
      readFileSync(join(root, '.overlaykit/governance/plan.json'), 'utf8'),
    ) as unknown;
    const storedManifest = JSON.parse(
      readFileSync(join(root, '.overlaykit/governance/manifest.json'), 'utf8'),
    ) as unknown;

    expect(canonicalJson(storedPlan)).toBe(canonicalJson(plan));
    expect(canonicalJson(storedManifest)).toBe(canonicalJson(manifest));
  });
});
