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
});
