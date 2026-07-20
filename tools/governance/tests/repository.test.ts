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
