import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createProductionRouter } from '../../src/routes/production';
import { ChannelManager } from '../../src/services/ChannelManager';
import { ProductionService } from '../../src/services/ProductionService';
import {
  productionSnapshotHash,
  productionSnapshotPayload,
  type ProductionHistoryRecord,
  type ProductionSnapshotCommit,
  type ProductionSnapshotCommitInput,
  type ProductionStatePersistencePort,
} from '../../src/services/SqliteProductionStateStore';
import type { Storage } from '../../src/storage';
import type { ProductionSnapshot } from '../../src/types/production';
import type { Scene } from '../../src/types/scene';

function scene(id: string): Scene {
  return {
    id,
    name: `Scene ${id}`,
    elements: [
      {
        id: 'lower-third',
        tag: 'section',
        content: id,
        styles: {},
      },
    ],
  };
}

class RecoveryPersistence implements ProductionStatePersistencePort {
  readonly commits: ProductionSnapshotCommitInput[] = [];
  private readonly program: ProductionSnapshot;

  constructor() {
    const programScene = scene('program-live');
    this.program = {
      showId: 'show-1',
      bus: 'program',
      revision: 1,
      scene: programScene,
      elements: programScene.elements,
      variables: {},
      controls: [],
      orientation: 'landscape',
      updatedAt: 1_000,
    };
  }

  load() {
    return {
      snapshots: [
        {
          showId: 'show-1',
          target: 'program' as const,
          revision: 1,
          updatedAt: 1_000,
          payload: productionSnapshotPayload(this.program),
          snapshotHash: productionSnapshotHash(this.program),
        },
      ],
      quarantines: [
        {
          showId: 'show-1',
          target: 'preview' as const,
          revision: 1,
          rejectedSnapshotHash: 'a'.repeat(64),
          reason: 'Injected bounded corruption',
          detectedAt: 1_001,
        },
      ],
    };
  }

  quarantine(): void {}

  commit(input: ProductionSnapshotCommitInput): ProductionSnapshotCommit {
    this.commits.push(input);
    return {
      snapshotHash: productionSnapshotHash(input.snapshot),
      history: {
        schemaVersion: 'overlaykit-production-history/v1',
        globalSequence: 2,
        showId: input.snapshot.showId,
        target: input.snapshot.bus,
        revision: input.snapshot.revision,
        occurredAt: input.occurredAt,
        mutationKind: input.mutationKind,
        operationId: input.operationId ?? null,
        previousGlobalHash: 'b'.repeat(64),
        previousTargetHash: 'c'.repeat(64),
        snapshotHash: productionSnapshotHash(input.snapshot),
        rejectedSnapshotHash: input.rejectedSnapshotHash ?? null,
        recordHash: 'd'.repeat(64),
      },
    };
  }

  readHistory(): ReadonlyArray<ProductionHistoryRecord> {
    return [];
  }
}

function appFor(production: ProductionService) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const roles = req.header('x-test-roles')?.split(',').filter(Boolean) ?? [];
    req.authSession = {
      user: {
        id: 'human-1',
        email: 'human@overlaykit.local',
        displayName: 'Human',
        roles: roles as Array<'owner' | 'producer' | 'designer'>,
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    next();
  });
  const storage = {
    getShow: async (id: string) => (id === 'show-1' ? { id, archivedAt: null } : null),
  } as unknown as Storage;
  app.use('/api', createProductionRouter(storage, production));
  return app;
}

describe('production quarantine HTTP boundary', () => {
  it('isolates reads by target and permits only authorized explicit recovery', async () => {
    const persistence = new RecoveryPersistence();
    const production = new ProductionService(new ChannelManager());
    production.mountPersistence(persistence);
    const app = appFor(production);

    await request(app)
      .get('/api/shows/show-1/production/program')
      .set('x-test-roles', 'producer')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toMatchObject({ revision: 1, scene: { id: 'program-live' } });
      });
    await request(app)
      .get('/api/shows/show-1/production/preview')
      .set('x-test-roles', 'producer')
      .expect(503)
      .expect(({ body }) => {
        expect(body.error.code).toBe('PRODUCTION_TARGET_QUARANTINED');
      });
    await request(app)
      .get('/api/shows/show-1/production')
      .set('x-test-roles', 'producer')
      .expect(503);
    await request(app)
      .post('/api/shows/show-1/production/preview/recovery')
      .set('x-test-roles', 'producer')
      .send({ mode: 'reset', operationId: 'producer-reset' })
      .expect(403);

    await request(app)
      .post('/api/shows/show-1/production/preview/recovery')
      .set('x-test-roles', 'producer')
      .send({
        mode: 'restore',
        operationId: 'producer-restore',
        scene: scene('preview-restored'),
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toMatchObject({ revision: 2, scene: { id: 'preview-restored' } });
      });
    expect(persistence.commits).toEqual([
      expect.objectContaining({
        mutationKind: 'quarantine.restore',
        expectedPreviousRevision: 1,
        rejectedSnapshotHash: 'a'.repeat(64),
      }),
    ]);
    await request(app)
      .get('/api/shows/show-1/production/preview')
      .set('x-test-roles', 'producer')
      .expect(200);
  });
});
