import { describe, expect, it } from 'vitest';
import { type VisualContextFacts, type VisualIntent } from '@overlaykit/visual-protocol';
import { resolveAnnouncePersonProgram } from '../src/index.js';

const intent: VisualIntent = {
  id: 'intent_announce_rodrigo',
  task: 'announce',
  subject: {
    type: 'person',
    name: 'Rodrigo Vicente',
    role: 'Arquitecto de software',
  },
  desiredEffect: 'notice',
  importance: 'primary',
};

const capabilities = {
  dom: true,
  svg: true,
  canvas: false,
  cssAnimations: true,
  webAnimations: false,
  audio: false,
};

function context(surface: VisualContextFacts['surface']): VisualContextFacts {
  return {
    surface,
    viewport: {
      width: 1920,
      height: 1080,
      pixelRatio: 1,
      transparent: surface === 'broadcast.overlay',
    },
    temporalMode: surface === 'broadcast.overlay' ? 'live' : 'presenter-paced',
    interaction: surface === 'broadcast.overlay' ? 'operator' : 'presenter',
    safeAreas: [{ x: 64, y: 64, width: 1792, height: 952 }],
    ...(surface === 'broadcast.overlay' ? { expectedDuration: 6_000 } : {}),
    audienceDistance: surface === 'broadcast.overlay' ? 'medium' : 'near',
    attentionBudget: 'medium',
    reducedMotion: false,
    capabilities,
  };
}

describe('announce-person MVP resolver', () => {
  it('selects a lower-third for broadcast and title/profile recipes for presentation', () => {
    const broadcast = resolveAnnouncePersonProgram({
      intent,
      context: context('broadcast.overlay'),
    });
    const presentation = resolveAnnouncePersonProgram({
      intent,
      context: context('presentation.slide'),
    });

    expect(broadcast.composition.recipeId).toBe('broadcast.lower-third');
    expect(broadcast.composition.children?.map((child) => child.recipeId)).toEqual([
      'broadcast.lower-third',
    ]);
    expect(presentation.composition.recipeId).toBe('presentation.title-card');
    expect(presentation.composition.children?.map((child) => child.recipeId)).toEqual([
      'presentation.title-card',
      'presentation.profile-card',
    ]);
    expect(broadcast.programHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(presentation.programHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(broadcast.programHash).not.toBe(presentation.programHash);
  });

  it('keeps temporal verbs target-neutral and records rejected candidates', () => {
    const program = resolveAnnouncePersonProgram({
      intent,
      context: context('broadcast.overlay'),
    });

    expect(program.timeline.cues[0].steps.map((step) => step.verb)).toEqual([
      'establish',
      'reveal',
      'hold',
      'dismiss',
    ]);
    expect(program.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'production-boundary',
        selected: 'preview-only-candidate',
      }),
    ]));
    expect(program.rejectedCandidates.map((candidate) => candidate.candidateId)).toEqual([
      'presentation.title-card',
      'presentation.profile-card',
    ]);
  });
});
