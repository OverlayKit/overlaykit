import { afterEach, describe, expect, it } from 'vitest';
import { FileStorage } from '../../src/storage/FileStorage';
import { DEFAULT_TENANT_ID } from '../../src/tenancy';
import { ChannelManager } from '../../src/services/ChannelManager';
import { ProductionService } from '../../src/services/ProductionService';
import type { CollectionRecord } from '../../src/storage';

/**
 * CHG-0053 / AC-007: a saved Scene carries a persisted, monotonic revision that advances on each
 * save and survives a fresh storage instance, while saving never perturbs Preview or Program.
 */
describe('saved Scene revision persists and is isolated from runtime', () => {
  const SHOW_ID = 'scene-revision-show';
  const ids: string[] = [];

  function record(id: string): CollectionRecord {
    return {
      id,
      tenantId: DEFAULT_TENANT_ID,
      name: 'Lower Third',
      channelId: SHOW_ID,
      scene: { id: 'scene-1', name: 'Lower Third', elements: [] },
      variables: {},
      updatedAt: 1,
    };
  }

  afterEach(async () => {
    const storage = new FileStorage();
    await storage.init();
    while (ids.length > 0) {
      await storage.deleteCollection(DEFAULT_TENANT_ID, ids.pop()!).catch(() => undefined);
    }
  });

  it('advances the revision on each save and persists it across a fresh instance', async () => {
    const id = `scene-revision-${process.pid}-a`;
    ids.push(id);
    const storage = new FileStorage();
    await storage.init();

    const first = await storage.saveCollection(record(id));
    expect(first.revision).toBe(1);
    expect((await storage.getCollection(DEFAULT_TENANT_ID, id))?.revision).toBe(1);

    const second = await storage.saveCollection(record(id));
    expect(second.revision).toBe(2);

    // The revision survives a fresh storage instance reading from disk.
    const reopened = new FileStorage();
    await reopened.init();
    expect((await reopened.getCollection(DEFAULT_TENANT_ID, id))?.revision).toBe(2);
  });

  it('does not change Preview or Program when a Scene is saved', async () => {
    const id = `scene-revision-${process.pid}-b`;
    ids.push(id);
    const storage = new FileStorage();
    await storage.init();
    const production = new ProductionService(new ChannelManager(), { allowEphemeral: true });

    // Prepare Preview so a perturbation would be observable.
    const loaded = production.loadPreview(SHOW_ID, { id: 'scene-1', name: 'Lower Third', elements: [] }, {});
    expect(loaded.preview.revision).toBe(1);
    expect(loaded.program.revision).toBe(0);

    await storage.saveCollection(record(id));
    await storage.saveCollection(record(id));

    const state = production.getState(SHOW_ID);
    expect(state.preview.revision).toBe(1);
    expect(state.program.revision).toBe(0);
  });
});
