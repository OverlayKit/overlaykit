import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { ChannelManager } from '../../src/services/ChannelManager';
import {
  ProductionError,
  ProductionService,
  productionRouteKey,
} from '../../src/services/ProductionService';
import type { Scene } from '../../src/types/scene';

function scene(id = 'scene-1'): Scene {
  return {
    id,
    name: `Scene ${id}`,
    orientation: 'portrait',
    elements: [{ id: `${id}-title`, tag: 'div', content: '{{title}}', styles: {} }],
  };
}

function controlledScene(): Scene {
  return {
    id: 'scoreboard',
    name: 'Scoreboard',
    elements: [
      {
        id: 'score-card',
        tag: 'section',
        styles: {},
        controls: [
          { id: 'score.home', label: 'Home score', type: 'number', path: 'score.home', min: 0, max: 20, step: 1 },
          { id: 'score.visible', label: 'Visible', type: 'toggle', path: 'flags.score' },
          {
            id: 'score.accent',
            label: 'Accent',
            type: 'select',
            path: 'theme.accent',
            options: [
              { label: 'Cyan', value: 'cyan' },
              { label: 'Gold', value: 'gold' },
            ],
          },
        ],
      },
    ],
  };
}

function socket(): WebSocket {
  return { readyState: 1, send: vi.fn() } as unknown as WebSocket;
}

describe('ProductionService', () => {
  let channels: ChannelManager;
  let production: ProductionService;

  beforeEach(() => {
    channels = new ChannelManager();
    production = new ProductionService(channels);
  });

  it('loads Preview without changing Program or the source Scene', () => {
    const source = scene();
    const before = JSON.stringify(source);
    const state = production.loadPreview('show-1', source, { title: 'Preview title' });

    expect(state.preview).toMatchObject({ revision: 1, orientation: 'portrait' });
    expect(state.preview.variables).toEqual({ title: 'Preview title' });
    expect(state.program).toMatchObject({ revision: 0, scene: null, elements: [] });
    expect(JSON.stringify(source)).toBe(before);
  });

  it('increments Preview independently and rejects a stale Take', () => {
    production.loadPreview('show-1', scene('one'));
    production.loadPreview('show-1', scene('two'));

    expect(() => production.take('show-1', 1, 'take-stale')).toThrowError(ProductionError);
    try {
      production.take('show-1', 1, 'take-stale');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'PREVIEW_REVISION_CONFLICT',
        status: 409,
        details: { expectedPreviewRevision: 1, actualPreviewRevision: 2 },
      });
    }
    expect(production.getState('show-1').program.revision).toBe(0);
  });

  it('atomically copies Preview to Program and is idempotent by operation id', () => {
    production.loadPreview('show-1', scene(), { title: 'Ready' });
    const first = production.take('show-1', 1, 'take-1');
    const repeated = production.take('show-1', 999, 'take-1');

    expect(first.program).toMatchObject({
      revision: 1,
      variables: { title: 'Ready' },
      orientation: 'portrait',
    });
    expect(first.program.elements).toEqual(first.preview.elements);
    expect(repeated.program.revision).toBe(1);
    expect(repeated.lastTake).toEqual(first.lastTake);
  });

  it('broadcasts snapshots and a shared Take acknowledgement', () => {
    const preview = socket();
    const program = socket();
    channels.subscribe(productionRouteKey('show-1', 'preview'), preview);
    channels.subscribe(productionRouteKey('show-1', 'program'), program);

    production.loadPreview('show-1', scene());
    production.take('show-1', 1, 'take-1');

    const previewMessages = (preview.send as ReturnType<typeof vi.fn>).mock.calls
      .map(([payload]) => JSON.parse(payload as string));
    const programMessages = (program.send as ReturnType<typeof vi.fn>).mock.calls
      .map(([payload]) => JSON.parse(payload as string));
    expect(previewMessages.map((message) => message.type)).toEqual([
      'production.snapshot',
      'production.taken',
    ]);
    expect(programMessages.map((message) => message.type)).toEqual([
      'production.snapshot',
      'production.taken',
    ]);
    expect(programMessages[0].snapshot.scene.id).toBe('scene-1');
  });

  it('returns the current snapshot without exposing mutable internal state', () => {
    production.loadPreview('show-1', scene(), { title: 'Original' });
    const snapshot = production.getSnapshot('show-1', 'preview');
    snapshot.variables.title = 'Mutated by caller';
    snapshot.elements.length = 0;

    expect(production.getSnapshot('show-1', 'preview')).toMatchObject({
      variables: { title: 'Original' },
      elements: [{ id: 'scene-1-title' }],
    });
  });

  it('derives declared controls and applies a batch only to Preview', () => {
    const source = controlledScene();
    const sourceBefore = JSON.stringify(source);
    production.loadPreview('show-1', source, {
      score: { home: 2 },
      flags: { score: true },
      theme: { accent: 'cyan' },
    });

    const updated = production.applyPreviewControls('show-1', 1, 'controls-1', {
      'score.home': 3,
      'score.visible': false,
      'score.accent': 'gold',
    });
    const repeated = production.applyPreviewControls('show-1', 999, 'controls-1', {
      'score.home': 9,
    });

    expect(updated.preview).toMatchObject({
      revision: 2,
      variables: { score: { home: 3 }, flags: { score: false }, theme: { accent: 'gold' } },
    });
    expect(updated.preview.controls.map((control) => [control.id, control.value])).toEqual([
      ['score.home', 3],
      ['score.visible', false],
      ['score.accent', 'gold'],
    ]);
    expect(updated.program).toMatchObject({ revision: 0, scene: null });
    expect(repeated.preview.revision).toBe(2);
    expect(JSON.stringify(source)).toBe(sourceBefore);
  });

  it('rejects stale, undeclared, and invalid control mutations atomically', () => {
    production.loadPreview('show-1', controlledScene(), {
      score: { home: 2 },
      flags: { score: true },
      theme: { accent: 'cyan' },
    });

    expect(() => production.applyPreviewControls('show-1', 0, 'stale', { 'score.home': 3 }))
      .toThrowError(ProductionError);
    expect(() => production.applyPreviewControls('show-1', 1, 'unknown', { 'score.away': 3 }))
      .toThrowError(ProductionError);
    expect(() => production.applyPreviewControls('show-1', 1, 'invalid', {
      'score.home': 4,
      'score.visible': 'yes',
    })).toThrowError(ProductionError);
    expect(production.getState('show-1').preview).toMatchObject({
      revision: 1,
      variables: { score: { home: 2 }, flags: { score: true } },
    });
  });

  it('rejects invalid or ambiguous component control declarations', () => {
    const unsafe = controlledScene();
    unsafe.elements[0].controls![0].path = '__proto__.polluted';
    expect(() => production.loadPreview('show-1', unsafe, {
      __proto__: { polluted: 1 },
      flags: { score: true },
      theme: { accent: 'cyan' },
    })).toThrowError(ProductionError);

    const duplicate = controlledScene();
    duplicate.elements[0].controls![1].id = 'score.home';
    expect(() => production.loadPreview('show-2', duplicate, {
      score: { home: 2 },
      flags: { score: true },
      theme: { accent: 'cyan' },
    })).toThrowError(ProductionError);

    expect(() => production.loadPreview('show-3', controlledScene(), {
      score: { home: 'two' },
      flags: { score: true },
      theme: { accent: 'cyan' },
    })).toThrowError(ProductionError);
  });
});
