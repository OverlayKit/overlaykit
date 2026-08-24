import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createProductionRouter } from '../../src/routes/production';
import { ChannelManager } from '../../src/services/ChannelManager';
import { ProductionService } from '../../src/services/ProductionService';
import type { Storage } from '../../src/storage';
import { compiledFixture } from '../e2e/support/outputProof';

/**
 * CHG-0054 / AC-008: the designer role (the acceptance criterion's actor) may Send a Scene to
 * Preview, but promoting Preview to Program with Take stays a producer decision. The role gate is
 * exercised through a session-injecting harness because the product currently issues only an owner
 * account (all roles); a designer-only account awaits user management.
 */
function appFor() {
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
  const production = new ProductionService(new ChannelManager(), { allowEphemeral: true });
  app.use('/api', createProductionRouter(storage, production));
  return app;
}

describe('production role gate: designer may Send to Preview, not Take', () => {
  const fixture = compiledFixture('intent_role_gate', 'Rodrigo Vicente', 'Arquitecto');
  const previewBody = { scene: fixture.candidate.scene, variables: fixture.candidate.variables };

  it('lets a designer Send to Preview', async () => {
    const app = appFor();
    const res = await request(app)
      .post('/api/shows/show-1/production/preview')
      .set('x-test-roles', 'designer')
      .send(previewBody);
    expect(res.status).toBe(200);
    expect(res.body.data.preview.revision).toBe(1);
    expect(res.body.data.program.revision).toBe(0);
  });

  it('denies a designer the Take', async () => {
    const app = appFor();
    await request(app)
      .post('/api/shows/show-1/production/preview')
      .set('x-test-roles', 'designer')
      .send(previewBody)
      .expect(200);
    const res = await request(app)
      .post('/api/shows/show-1/production/take')
      .set('x-test-roles', 'designer')
      .send({ expectedPreviewRevision: 1, operationId: 'role-gate-take' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('lets a producer Take', async () => {
    const app = appFor();
    await request(app)
      .post('/api/shows/show-1/production/preview')
      .set('x-test-roles', 'producer')
      .send(previewBody)
      .expect(200);
    const res = await request(app)
      .post('/api/shows/show-1/production/take')
      .set('x-test-roles', 'producer')
      .send({ expectedPreviewRevision: 1, operationId: 'role-gate-take' });
    expect(res.status).toBe(200);
    expect(res.body.data.program.revision).toBe(1);
  });
});
