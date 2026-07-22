import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { SqliteDeviceCredentialStore } from '../../src/auth/SqliteDeviceCredentialStore';
import { ChannelManager } from '../../src/services/ChannelManager';
import { ProductionService, productionRouteKey } from '../../src/services/ProductionService';
import {
  productionSnapshotHash,
  productionSnapshotPayload,
  type ProductionHistoryRecord,
  type ProductionSnapshotCommit,
  type ProductionSnapshotCommitInput,
  type ProductionStateLoadResult,
  type ProductionStatePersistencePort,
  type ProductionTargetQuarantine,
} from '../../src/services/SqliteProductionStateStore';
import type { Scene } from '../../src/types/scene';

const stores: SqliteDeviceCredentialStore[] = [];

function scene(id: string, content = id): Scene {
  return {
    id,
    name: `Scene ${id}`,
    orientation: 'landscape',
    elements: [
      {
        id: 'lower-third',
        tag: 'section',
        content,
        styles: {},
      },
    ],
  };
}

async function databasePath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overlaykit-production-service-'));
  return path.join(directory, 'authority.sqlite');
}

async function openService(
  file: string,
  options: Parameters<SqliteDeviceCredentialStore['createProductionStateStore']>[0] = {}
): Promise<{
  credentials: SqliteDeviceCredentialStore;
  persistence: ProductionStatePersistencePort;
  production: ProductionService;
}> {
  const credentials = new SqliteDeviceCredentialStore({ databasePath: file });
  stores.push(credentials);
  await credentials.init();
  const persistence = credentials.createProductionStateStore(options);
  const production = new ProductionService(new ChannelManager());
  production.mountPersistence(persistence);
  return { credentials, persistence, production };
}

function closeTracked(store: SqliteDeviceCredentialStore): void {
  store.close();
  stores.splice(stores.indexOf(store), 1);
}

class FailingPublicationChannels extends ChannelManager {
  override replaceVariables(): void {
    throw new Error('injected publication fault');
  }
}

class InjectedPersistence implements ProductionStatePersistencePort {
  readonly commits: ProductionSnapshotCommitInput[] = [];
  readonly quarantined: ProductionTargetQuarantine[] = [];

  constructor(
    private readonly onCommit: (input: ProductionSnapshotCommitInput) => void,
    private readonly loaded: ProductionStateLoadResult = {
      snapshots: [],
      quarantines: [],
    }
  ) {}

  load(): ProductionStateLoadResult {
    return this.loaded;
  }

  quarantine(input: ProductionTargetQuarantine): void {
    this.quarantined.push(input);
  }

  commit(input: ProductionSnapshotCommitInput): ProductionSnapshotCommit {
    this.onCommit(input);
    this.commits.push(input);
    const recordHash = 'a'.repeat(64);
    return {
      snapshotHash: 'b'.repeat(64),
      history: {
        schemaVersion: 'overlaykit-production-history/v1',
        globalSequence: this.commits.length,
        showId: input.snapshot.showId,
        target: input.snapshot.bus,
        revision: input.snapshot.revision,
        occurredAt: input.occurredAt,
        mutationKind: input.mutationKind,
        operationId: input.operationId ?? null,
        previousGlobalHash: null,
        previousTargetHash: null,
        snapshotHash: 'b'.repeat(64),
        rejectedSnapshotHash: input.rejectedSnapshotHash ?? null,
        recordHash,
      },
    };
  }

  readHistory(): ReadonlyArray<ProductionHistoryRecord> {
    return [];
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe('durable ProductionService authority', () => {
  it('fails closed by default until durable production authority is mounted', () => {
    const production = new ProductionService(new ChannelManager());

    expect(() => production.getSnapshot('show-1', 'preview')).toThrowError(
      expect.objectContaining({ code: 'PRODUCTION_AUTHORITY_NOT_READY', status: 503 })
    );
    expect(() => production.loadPreview('show-1', scene('unmounted'))).toThrowError(
      expect.objectContaining({ code: 'PRODUCTION_AUTHORITY_NOT_READY', status: 503 })
    );
  });

  it('does not expose a candidate to memory, observers, or channels before commit', () => {
    const channels = new ChannelManager();
    const production = new ProductionService(channels);
    const observer = vi.fn();
    const socket = {
      readyState: 1,
      send: vi.fn(),
    } as unknown as WebSocket;
    let persistence!: InjectedPersistence;
    persistence = new InjectedPersistence((input) => {
      expect(input.snapshot.revision).toBe(1);
      expect(production.getSnapshot('show-1', 'preview').revision).toBe(0);
      expect(observer).not.toHaveBeenCalled();
      expect(socket.send).not.toHaveBeenCalled();
    });
    production.mountPersistence(persistence);
    production.subscribe('show-1', observer);
    channels.subscribe(productionRouteKey('show-1', 'preview'), socket);

    production.loadPreview('show-1', scene('committed'));

    expect(persistence.commits).toHaveLength(1);
    expect(production.getSnapshot('show-1', 'preview').revision).toBe(1);
    expect(observer).toHaveBeenCalledOnce();
    expect(socket.send).toHaveBeenCalledOnce();
  });

  it('serializes reentrant publications and isolates observer state', () => {
    const channels = new ChannelManager();
    const production = new ProductionService(channels);
    const persistence = new InjectedPersistence(() => undefined);
    const socket = {
      readyState: 1,
      send: vi.fn(),
    } as unknown as WebSocket;
    const observedRevisions: number[] = [];
    let nested = false;
    production.mountPersistence(persistence);
    production.subscribe('show-1', (observation) => {
      const revision = observation.state.preview.revision;
      observation.state.preview.revision = 999;
      if (!nested && revision === 1) {
        nested = true;
        production.loadPreview('show-1', scene('revision-2'));
      }
    });
    production.subscribe('show-1', (observation) => {
      observedRevisions.push(observation.state.preview.revision);
    });
    channels.subscribe(productionRouteKey('show-1', 'preview'), socket);

    production.loadPreview('show-1', scene('revision-1'));

    expect(observedRevisions).toEqual([1, 2]);
    expect(production.getSnapshot('show-1', 'preview')).toMatchObject({
      revision: 2,
      scene: { id: 'revision-2' },
    });
    expect(channels.getElements(productionRouteKey('show-1', 'preview'))).toMatchObject([
      { content: 'revision-2' },
    ]);
    expect(
      (socket.send as ReturnType<typeof vi.fn>).mock.calls.map(
        ([message]) => JSON.parse(message as string).snapshot.revision
      )
    ).toEqual([1, 2]);
  });

  it('keeps old truth unpublished and fails closed after a commit fault', () => {
    const channels = new ChannelManager();
    const production = new ProductionService(channels);
    const fatal = vi.fn();
    const observer = vi.fn();
    const socket = {
      readyState: 1,
      send: vi.fn(),
    } as unknown as WebSocket;
    production.mountPersistence(
      new InjectedPersistence(() => {
        throw new Error('injected commit fault');
      }),
      fatal
    );
    production.subscribe('show-1', observer);
    channels.subscribe(productionRouteKey('show-1', 'preview'), socket);

    expect(() => production.loadPreview('show-1', scene('rejected'))).toThrowError(
      expect.objectContaining({ code: 'PRODUCTION_AUTHORITY_FAILED', status: 503 })
    );
    expect(fatal).toHaveBeenCalledOnce();
    expect(observer).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
    expect(() => production.getSnapshot('show-1', 'preview')).toThrowError(
      expect.objectContaining({ code: 'PRODUCTION_AUTHORITY_FAILED' })
    );
  });

  it('fails closed after publication fault while a successor restores committed truth', async () => {
    const file = await databasePath();
    const credentials = new SqliteDeviceCredentialStore({ databasePath: file });
    stores.push(credentials);
    await credentials.init();
    const production = new ProductionService(new FailingPublicationChannels());
    const fatal = vi.fn();
    production.mountPersistence(credentials.createProductionStateStore(), fatal);

    expect(() => production.loadPreview('show-1', scene('published-later'))).toThrowError(
      expect.objectContaining({ code: 'PRODUCTION_PUBLICATION_FAILED', status: 503 })
    );
    expect(fatal).toHaveBeenCalledOnce();
    expect(() => production.getSnapshot('show-1', 'preview')).toThrowError(
      expect.objectContaining({ code: 'PRODUCTION_AUTHORITY_FAILED' })
    );
    closeTracked(credentials);

    const successor = await openService(file);
    expect(successor.production.getSnapshot('show-1', 'preview')).toMatchObject({
      revision: 1,
      scene: { id: 'published-later' },
    });
    expect(successor.persistence.readHistory()).toHaveLength(1);
  });

  it('rejects malformed operation identity without poisoning durable authority', () => {
    const persistence = new InjectedPersistence(() => undefined);
    const production = new ProductionService(new ChannelManager());
    production.mountPersistence(persistence);
    production.loadPreview('show-1', scene('valid'));

    expect(() => production.take('show-1', 1, '  ')).toThrowError(
      expect.objectContaining({ code: 'INVALID_OPERATION_ID', status: 400 })
    );
    expect(production.getSnapshot('show-1', 'preview').revision).toBe(1);
    expect(production.getSnapshot('show-1', 'program').revision).toBe(0);
    expect(persistence.commits).toHaveLength(1);
  });

  it('propagates a cue commit failure instead of reporting a recoverable step failure', () => {
    let commits = 0;
    const production = new ProductionService(new ChannelManager());
    production.mountPersistence(
      new InjectedPersistence(() => {
        commits += 1;
        if (commits === 2) throw new Error('injected cue commit fault');
      })
    );
    production.loadPreview('show-1', scene('cue'));

    expect(() =>
      production.executeCue(
        {
          cue: {
            id: 'fatal-cue',
            showId: 'show-1',
            target: 'preview',
            steps: [
              {
                id: 'hide',
                kind: 'component.visibility',
                componentId: 'lower-third',
                visible: false,
              },
            ],
          },
          operationId: 'fatal-cue-run',
          expectedRevision: 1,
        },
        { directProgram: false }
      )
    ).toThrowError(expect.objectContaining({ code: 'PRODUCTION_AUTHORITY_FAILED', status: 503 }));
  });

  it('restores canonical Preview and Program truth across a successor runtime', async () => {
    const file = await databasePath();
    const first = await openService(file);
    first.production.loadPreview('show-1', scene('restart', 'Durable lower third'), {
      presenter: 'Rodrigo',
    });
    first.production.take('show-1', 1, 'take-restart');
    first.production.executeVisibilityIntent(
      {
        kind: 'component.visibility',
        showId: 'show-1',
        target: 'program',
        componentId: 'lower-third',
        visible: false,
        operationId: 'hide-restart',
        expectedRevision: 1,
      },
      { directProgram: true }
    );
    const expectedPreview = first.production.getSnapshot('show-1', 'preview');
    const expectedProgram = first.production.getSnapshot('show-1', 'program');
    closeTracked(first.credentials);

    const successor = await openService(file);
    expect(successor.production.getSnapshot('show-1', 'preview')).toEqual(expectedPreview);
    expect(successor.production.getSnapshot('show-1', 'program')).toEqual(expectedProgram);
  });

  it('restores template-bearing scenes without changing their normalized structure', async () => {
    const file = await databasePath();
    const first = await openService(file);
    first.production.loadPreview(
      'show-1',
      {
        id: 'template-scene',
        name: 'Template Scene',
        elements: [
          {
            id: 'templated-lower-third',
            tag: 'section',
            content: '{{headline}}',
            attributes: { title: '{{headline}}' },
            styles: { color: '{{accent}}' },
          },
        ],
      },
      { headline: 'Rodrigo', accent: '#ffcc00' }
    );
    const expected = first.production.getSnapshot('show-1', 'preview');
    closeTracked(first.credentials);

    const successor = await openService(file);
    expect(successor.production.listQuarantines('show-1')).toHaveLength(0);
    expect(successor.production.getSnapshot('show-1', 'preview')).toEqual(expected);
  });

  it('quarantines one corrupted target while preserving sibling target truth', async () => {
    const file = await databasePath();
    const first = await openService(file);
    first.production.loadPreview('show-1', scene('isolation'));
    first.production.take('show-1', 1, 'take-isolation');
    closeTracked(first.credentials);

    const tamper = new DatabaseSync(file);
    tamper
      .prepare(
        `
      UPDATE production_current_snapshots SET payload = ?
      WHERE show_id = ? AND target = ?
    `
      )
      .run('{"corrupted":true}', 'show-1', 'preview');
    tamper.close();

    const successor = await openService(file);
    expect(successor.production.getSnapshot('show-1', 'program')).toMatchObject({
      revision: 1,
      scene: { id: 'isolation' },
    });
    successor.production.executeVisibilityIntent(
      {
        kind: 'component.visibility',
        showId: 'show-1',
        target: 'program',
        componentId: 'lower-third',
        visible: false,
        operationId: 'program-remains-live',
        expectedRevision: 1,
      },
      { directProgram: true }
    );
    expect(successor.production.getSnapshot('show-1', 'program')).toMatchObject({
      revision: 2,
      elements: [{ styles: { display: 'none' } }],
    });
    expect(() => successor.production.getSnapshot('show-1', 'preview')).toThrowError(
      expect.objectContaining({ code: 'PRODUCTION_TARGET_QUARANTINED' })
    );
    expect(() => successor.production.getState('show-1')).toThrowError(
      expect.objectContaining({ code: 'PRODUCTION_TARGET_QUARANTINED' })
    );
    expect(successor.production.listQuarantines('show-1')).toEqual([
      expect.objectContaining({ showId: 'show-1', target: 'preview', revision: 1 }),
    ]);
  });

  it('requires human role authority and records Producer restore evidence', async () => {
    const file = await databasePath();
    const first = await openService(file);
    first.production.loadPreview('show-1', scene('rejected'));
    closeTracked(first.credentials);

    const tamper = new DatabaseSync(file);
    tamper
      .prepare(
        `
      UPDATE production_current_snapshots SET payload = ?
      WHERE show_id = ? AND target = ?
    `
      )
      .run('{"corrupted":true}', 'show-1', 'preview');
    tamper.close();

    const successor = await openService(file);
    const quarantine = successor.production.listQuarantines('show-1')[0];
    const base = {
      showId: 'show-1',
      target: 'preview' as const,
      operationId: 'recover-preview',
    };
    expect(() =>
      successor.production.recoverTarget({
        ...base,
        mode: 'restore',
        roles: [],
        scene: scene('restored'),
      })
    ).toThrowError(expect.objectContaining({ code: 'PRODUCTION_RECOVERY_FORBIDDEN' }));
    expect(() =>
      successor.production.recoverTarget({
        ...base,
        mode: 'reset',
        roles: ['producer'],
      })
    ).toThrowError(expect.objectContaining({ code: 'PRODUCTION_RESET_FORBIDDEN' }));
    expect(() =>
      successor.production.recoverTarget({
        ...base,
        mode: 'restore',
        roles: ['producer'],
        scene: { id: '', name: '', elements: [] },
      })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SCENE' }));
    expect(successor.production.listQuarantines('show-1')).toHaveLength(1);

    const restored = successor.production.recoverTarget({
      ...base,
      mode: 'restore',
      roles: ['producer'],
      scene: scene('restored', 'Validated replacement'),
    });
    expect(restored).toMatchObject({ revision: 2, scene: { id: 'restored' } });
    expect(successor.production.listQuarantines('show-1')).toHaveLength(0);
    const mountedHistory = successor.persistence.readHistory();
    expect(mountedHistory.at(-1)).toMatchObject({
      mutationKind: 'quarantine.restore',
      revision: 2,
      rejectedSnapshotHash: quarantine.rejectedSnapshotHash,
    });
    closeTracked(successor.credentials);

    const afterRestart = await openService(file);
    expect(afterRestart.production.getSnapshot('show-1', 'preview')).toEqual(restored);
  });

  it('lets only Owner reset a missing quarantined target to a new empty revision', async () => {
    const file = await databasePath();
    const first = await openService(file);
    first.production.loadPreview('show-1', scene('missing-current'));
    first.production.take('show-1', 1, 'take-missing-current');
    closeTracked(first.credentials);

    const tamper = new DatabaseSync(file);
    tamper
      .prepare(
        `
      DELETE FROM production_current_snapshots
      WHERE show_id = ? AND target = ?
    `
      )
      .run('show-1', 'program');
    tamper.close();

    const successor = await openService(file);
    const reset = successor.production.recoverTarget({
      showId: 'show-1',
      target: 'program',
      mode: 'reset',
      operationId: 'owner-reset',
      roles: ['owner'],
    });
    expect(reset).toMatchObject({
      revision: 2,
      scene: null,
      elements: [],
      variables: {},
      controls: [],
    });
    expect(successor.production.getSnapshot('show-1', 'program')).toEqual(reset);
    closeTracked(successor.credentials);

    const afterRestart = await openService(file);
    expect(afterRestart.production.getSnapshot('show-1', 'program')).toEqual(reset);
  });

  it('recovers a target whose current revision column is corrupt from history authority', async () => {
    const file = await databasePath();
    const first = await openService(file);
    first.production.loadPreview('show-1', scene('revision-corruption'));
    closeTracked(first.credentials);

    const tamper = new DatabaseSync(file);
    tamper.exec('PRAGMA ignore_check_constraints = ON');
    tamper
      .prepare(
        `
      UPDATE production_current_snapshots SET revision = ?
      WHERE show_id = ? AND target = ?
    `
      )
      .run(99, 'show-1', 'preview');
    tamper.close();

    const successor = await openService(file);
    expect(successor.production.listQuarantines('show-1')).toEqual([
      expect.objectContaining({ target: 'preview', revision: 1 }),
    ]);
    const restored = successor.production.recoverTarget({
      showId: 'show-1',
      target: 'preview',
      mode: 'restore',
      operationId: 'recover-revision',
      roles: ['owner'],
      scene: scene('revision-restored'),
    });
    expect(restored).toMatchObject({ revision: 2, scene: { id: 'revision-restored' } });
  });

  it('keeps quarantine durable when the recovery commit fails', async () => {
    const file = await databasePath();
    const first = await openService(file);
    first.production.loadPreview('show-1', scene('recovery-fault'));
    closeTracked(first.credentials);

    const tamper = new DatabaseSync(file);
    tamper
      .prepare(
        `
      UPDATE production_current_snapshots SET payload = ?
      WHERE show_id = ? AND target = ?
    `
      )
      .run('{"corrupted":true}', 'show-1', 'preview');
    tamper.close();

    const failing = await openService(file, {
      beforeCommit(phase, input) {
        if (phase === 'snapshot' && input?.mutationKind === 'quarantine.restore') {
          throw new Error('injected recovery commit fault');
        }
      },
    });
    expect(() =>
      failing.production.recoverTarget({
        showId: 'show-1',
        target: 'preview',
        mode: 'restore',
        operationId: 'failed-recovery',
        roles: ['owner'],
        scene: scene('never-committed'),
      })
    ).toThrowError(expect.objectContaining({ code: 'PRODUCTION_AUTHORITY_FAILED' }));
    closeTracked(failing.credentials);

    const successor = await openService(file);
    expect(successor.persistence.readHistory()).toHaveLength(1);
    expect(successor.production.listQuarantines('show-1')).toEqual([
      expect.objectContaining({ target: 'preview', revision: 1 }),
    ]);
    expect(() => successor.production.getSnapshot('show-1', 'preview')).toThrowError(
      expect.objectContaining({ code: 'PRODUCTION_TARGET_QUARANTINED' })
    );
  });

  it('quarantines structurally invalid canonical rows supplied by persistence', () => {
    const invalid = {
      showId: 'show-1',
      target: 'preview' as const,
      revision: 1,
      updatedAt: 1_000,
      snapshotHash: 'c'.repeat(64),
      payload: JSON.stringify({
        schemaVersion: 'overlaykit-production-snapshot/v1',
        snapshot: {
          showId: 'show-1',
          bus: 'preview',
          revision: 1,
          scene: null,
          elements: [{ id: 'impossible' }],
          variables: {},
          controls: [],
          orientation: 'landscape',
          updatedAt: 1_000,
        },
      }),
    };
    const persistence = new InjectedPersistence(() => undefined, {
      snapshots: [invalid],
      quarantines: [],
    });
    const production = new ProductionService(new ChannelManager());

    const mounted = production.mountPersistence(persistence);

    expect(mounted).toEqual({ restoredTargets: 0, quarantinedTargets: 1 });
    expect(persistence.quarantined).toEqual([
      expect.objectContaining({ showId: 'show-1', target: 'preview', revision: 1 }),
    ]);
    expect(() => production.getSnapshot('show-1', 'preview')).toThrowError(
      expect.objectContaining({ code: 'PRODUCTION_TARGET_QUARANTINED' })
    );
  });

  it('quarantines a valid live tree that does not derive from its Scene', () => {
    const authoredScene = scene('authored', 'Authored lower third');
    const snapshot = {
      showId: 'show-1',
      bus: 'preview' as const,
      revision: 1,
      scene: authoredScene,
      elements: scene('drifted', 'Different lower third').elements,
      variables: {},
      controls: [],
      orientation: 'landscape' as const,
      updatedAt: 1_000,
    };
    const persistence = new InjectedPersistence(() => undefined, {
      snapshots: [
        {
          showId: 'show-1',
          target: 'preview',
          revision: 1,
          updatedAt: 1_000,
          payload: productionSnapshotPayload(snapshot),
          snapshotHash: productionSnapshotHash(snapshot),
        },
      ],
      quarantines: [],
    });
    const production = new ProductionService(new ChannelManager());

    expect(production.mountPersistence(persistence)).toEqual({
      restoredTargets: 0,
      quarantinedTargets: 1,
    });
    expect(persistence.quarantined).toEqual([
      expect.objectContaining({
        showId: 'show-1',
        target: 'preview',
        reason: expect.stringContaining('do not derive'),
      }),
    ]);
  });
});
