import { describe, expect, it } from 'vitest';
import type { ResolvedVisualProgram } from '@overlaykit/visual-protocol';
import { compileOverlayKitDomProgram } from '../src/index.js';

function program(recipe: 'broadcast' | 'presentation'): ResolvedVisualProgram {
  const recipeId = recipe === 'broadcast' ? 'broadcast.lower-third' : 'presentation.title-card';
  return {
    id: `vp_${recipe}`,
    intentRef: 'intent_announce_rodrigo',
    profileRef: `${recipe}.profile@1.0.0`,
    constitutionRef: 'teamx.identity@1.0.0+announce-person@1.0.0',
    programHash: `${recipe === 'broadcast' ? 'a' : 'b'}`.repeat(64),
    composition: {
      id: 'composition',
      primitive: 'identity.announce-person',
      recipeId,
      role: 'container',
      children:
        recipe === 'broadcast'
          ? [
              {
                id: 'subject',
                primitive: 'identity.announce-person',
                recipeId: 'broadcast.lower-third',
                role: 'subject',
              },
            ]
          : [
              {
                id: 'title',
                primitive: 'identity.announce-person',
                recipeId: 'presentation.title-card',
                role: 'subject',
              },
              {
                id: 'profile',
                primitive: 'identity.announce-person',
                recipeId: 'presentation.profile-card',
                role: 'supporting-role',
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
            { id: 'reveal-role', verb: 'reveal', target: 'supporting-role', durationMs: 240 },
            { id: 'hold-readable', verb: 'hold', target: 'composition', durationMs: 6_000 },
            { id: 'dismiss-composition', verb: 'dismiss', target: 'composition', durationMs: 160 },
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
    decisions: [
      {
        id: 'production-boundary',
        kind: 'constraint',
        selected: 'preview-only-candidate',
        reason: 'OverlayKit owns Take',
      },
    ],
    rejectedCandidates: [],
  };
}

describe('OverlayKit visual target lowering', () => {
  it('emits a lower-third Scene without embedding the full constitution', () => {
    const source = program('broadcast');
    const artifact = compileOverlayKitDomProgram(source);

    expect(artifact.target).toBe('overlaykit.dom-protocol/v1');
    expect(artifact.scene.elements[0].id).toContain('lower-third');
    expect(artifact.scene.meta).toMatchObject({
      visualProgramId: 'vp_broadcast',
      intentRef: 'intent_announce_rodrigo',
      profileRef: 'broadcast.profile@1.0.0',
      compilerVersion: '0.2.0',
    });
    expect(artifact.scene).not.toHaveProperty('variables');
    expect(artifact.bindingPlan).toEqual(source.bindings);
    expect(artifact.bindingPlan).not.toBe(source.bindings);
    expect(artifact.bindingPlan[0]).not.toBe(source.bindings[0]);
    expect(Object.isFrozen(artifact.bindingPlan)).toBe(true);
    expect(artifact.bindingPlan.every((binding) => Object.isFrozen(binding))).toBe(true);
    expect(JSON.stringify(artifact.scene.meta)).not.toContain('hardConstraints');
    expect(artifact.bundle.generatedCss).toBeUndefined();
    expect(artifact.manifest.programHash).toBe(artifact.programHash);
  });

  it('emits a presentation title/profile card with the same DOM Protocol target', () => {
    const artifact = compileOverlayKitDomProgram(program('presentation'));

    expect(artifact.scene.elements[0].id).toContain('title-card');
    expect(JSON.stringify(artifact.scene.elements)).toContain('profile-card');
    expect(artifact.timeline?.cues[0].steps.map((step) => step.verb)).toEqual([
      'establish',
      'reveal',
      'hold',
      'dismiss',
    ]);
    expect(artifact.bundle.bundleHash).toMatch(/^[0-9a-f]{64}$/u);
  });
});
