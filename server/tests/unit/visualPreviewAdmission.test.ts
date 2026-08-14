import { describe, expect, it } from 'vitest';
import { resolveAnnouncePersonProgram } from '@overlaykit/visual-compiler';
import type { VisualContextFacts, VisualIntent } from '@overlaykit/visual-protocol';
import {
  compileOverlayKitDomProgram,
  prepareOverlayKitPreviewCandidate,
} from '@overlaykit/visual-target-overlaykit';
import { ChannelManager } from '../../src/services/ChannelManager';
import { ProductionService } from '../../src/services/ProductionService';

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
    capabilities: {
      dom: true,
      svg: true,
      canvas: false,
      cssAnimations: true,
      webAnimations: false,
      audio: false,
    },
  };
}

describe('compiled visual Preview admission', () => {
  it('admits both visual surfaces without granting Program authority', () => {
    const production = new ProductionService(new ChannelManager(), { allowEphemeral: true });
    const surfaces: ReadonlyArray<VisualContextFacts['surface']> = [
      'broadcast.overlay',
      'presentation.slide',
    ];

    surfaces.forEach((surface, index) => {
      const program = resolveAnnouncePersonProgram({ intent, context: context(surface) });
      const artifact = compileOverlayKitDomProgram(program);
      const candidate = prepareOverlayKitPreviewCandidate(artifact, {
        'person-name': intent.subject.name,
        'person-role': intent.subject.role,
      });
      const state = production.loadPreview(
        'show-visual-admission',
        candidate.scene,
        candidate.variables
      );

      expect(state.preview.revision).toBe(index + 1);
      expect(state.preview.scene?.meta).toMatchObject({
        visualProgramId: program.id,
        programHash: artifact.programHash,
        bundleHash: artifact.bundle.bundleHash,
        intentRef: intent.id,
        evidenceRef: expect.stringMatching(/^compilation:[0-9a-f]{64}$/u),
      });
      expect(state.preview.variables).toEqual({
        intent_announce_rodrigo: {
          subject: {
            name: 'Rodrigo Vicente',
            role: 'Arquitecto de software',
          },
        },
      });
      expect(state.preview.scene).not.toHaveProperty('variables');
      expect(state.program).toMatchObject({ revision: 0, scene: null, elements: [] });
      expect(state.lastTake).toBeNull();
    });
  });
});
