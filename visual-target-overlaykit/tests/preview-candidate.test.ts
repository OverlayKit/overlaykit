import { describe, expect, it } from 'vitest';
import type { ResolvedVisualProgram, SemanticBinding } from '@overlaykit/visual-protocol';
import {
  compileOverlayKitDomProgram,
  prepareOverlayKitPreviewCandidate,
  type OverlayKitDomProgramArtifact,
} from '../src/index.js';

function program(): ResolvedVisualProgram {
  return {
    id: 'vp_binding',
    intentRef: 'intent_announce_rodrigo',
    profileRef: 'broadcast.profile@1.0.0',
    constitutionRef: 'teamx.identity@1.0.0+announce-person@1.0.0',
    programHash: 'a'.repeat(64),
    composition: {
      id: 'composition',
      primitive: 'identity.announce-person',
      recipeId: 'broadcast.lower-third',
      role: 'container',
      children: [
        {
          id: 'subject',
          primitive: 'identity.announce-person',
          recipeId: 'broadcast.lower-third',
          role: 'subject',
        },
      ],
    },
    timeline: {
      cues: [
        {
          id: 'intro',
          trigger: { type: 'on-load' },
          execution: 'sequence',
          steps: [
            { id: 'establish-subject', verb: 'establish', target: 'subject', durationMs: 420 },
          ],
        },
      ],
    },
    bindings: [
      {
        id: 'person-name',
        path: 'subject.name',
        source: 'intent_announce_rodrigo.subject.name',
      },
      {
        id: 'person-role',
        path: 'subject.role',
        source: 'intent_announce_rodrigo.subject.role',
      },
    ],
    controls: [{ id: 'dismiss', label: 'Dismiss', kind: 'dismiss' }],
    requiredCapabilities: [
      { capability: 'dom', required: true },
      { capability: 'cssAnimations', required: true },
    ],
    decisions: [],
    rejectedCandidates: [],
  };
}

function artifact(bindings?: ReadonlyArray<SemanticBinding>): OverlayKitDomProgramArtifact {
  const compiled = compileOverlayKitDomProgram(program());
  return bindings === undefined
    ? compiled
    : { ...compiled, bindingPlan: bindings.map((binding) => ({ ...binding })) };
}

describe('OverlayKit Preview candidate binding', () => {
  it('separates host Scene from deterministic nested runtime variables', () => {
    const compiled = artifact();
    const before = JSON.stringify(compiled);
    const values = {
      'person-role': 'Arquitecto de software',
      'person-name': 'Rodrigo Vicente',
    };

    const candidate = prepareOverlayKitPreviewCandidate(compiled, values);
    const reordered = prepareOverlayKitPreviewCandidate(compiled, {
      'person-name': 'Rodrigo Vicente',
      'person-role': 'Arquitecto de software',
    });

    expect(candidate.scene).not.toHaveProperty('variables');
    expect(candidate.variables).toEqual({
      intent_announce_rodrigo: {
        subject: {
          name: 'Rodrigo Vicente',
          role: 'Arquitecto de software',
        },
      },
    });
    expect(candidate).toEqual(reordered);
    expect(JSON.stringify(compiled)).toBe(before);
    expect(values).toEqual({
      'person-role': 'Arquitecto de software',
      'person-name': 'Rodrigo Vicente',
    });
  });

  it('rejects missing, unknown, object, undefined, and non-finite values', () => {
    const compiled = artifact();

    expect(() =>
      prepareOverlayKitPreviewCandidate(compiled, {
        'person-name': 'Rodrigo Vicente',
      })
    ).toThrowError(/person-role requires a value/u);
    expect(() =>
      prepareOverlayKitPreviewCandidate(compiled, {
        'person-name': 'Rodrigo Vicente',
        'person-role': 'Arquitecto',
        extra: true,
      })
    ).toThrowError(/extra is not declared/u);
    expect(() =>
      prepareOverlayKitPreviewCandidate(compiled, {
        'person-name': { nested: 'Rodrigo' },
        'person-role': 'Arquitecto',
      })
    ).toThrowError(/person-name requires a string/u);
    expect(() =>
      prepareOverlayKitPreviewCandidate(compiled, {
        'person-name': undefined,
        'person-role': 'Arquitecto',
      })
    ).toThrowError(/person-name requires a string/u);
    expect(() =>
      prepareOverlayKitPreviewCandidate(compiled, {
        'person-name': 'Rodrigo Vicente',
        'person-role': Number.NaN,
      })
    ).toThrowError(/person-role requires a string/u);
  });

  it('rejects duplicate identifiers, unsafe paths, path collisions, and identity drift', () => {
    const duplicate = artifact([
      { id: 'person', path: 'subject.name', source: 'intent.subject.name' },
      { id: 'person', path: 'subject.role', source: 'intent.subject.role' },
    ]);
    expect(() => prepareOverlayKitPreviewCandidate(duplicate, { person: 'Rodrigo' })).toThrowError(
      /identifiers must be non-empty and unique/u
    );

    const unsafe = artifact([
      { id: 'person', path: 'subject.name', source: 'intent.__proto__.name' },
    ]);
    expect(() => prepareOverlayKitPreviewCandidate(unsafe, { person: 'Rodrigo' })).toThrowError(
      /unsafe source path/u
    );

    const colliding = artifact([
      { id: 'subject', path: 'subject', source: 'intent.subject' },
      { id: 'name', path: 'subject.name', source: 'intent.subject.name' },
    ]);
    expect(() =>
      prepareOverlayKitPreviewCandidate(colliding, {
        subject: 'Rodrigo',
        name: 'Rodrigo Vicente',
      })
    ).toThrowError(/collides with another source path/u);

    const drifted = artifact() as OverlayKitDomProgramArtifact & { programHash: string };
    Object.defineProperty(drifted, 'programHash', { value: 'f'.repeat(64) });
    expect(() =>
      prepareOverlayKitPreviewCandidate(drifted, {
        'person-name': 'Rodrigo Vicente',
        'person-role': 'Arquitecto',
      })
    ).toThrowError(/identities do not agree/u);
  });
});
