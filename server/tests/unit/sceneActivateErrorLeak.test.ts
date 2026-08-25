import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

// CHG-0078 / hardening-scene-activate-error-leak: an unexpected failure in POST /api/scenes/activate
// must be named to the client without leaking the internal error string. The raw error stays in the
// server log only, matching the two sibling 500 handlers in this router.
const SECRET = 'internal detail: sqlite at /var/lib/overlaykit/secret.db';

vi.mock('../../src/services/sceneActivation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/sceneActivation')>();
  return {
    ...actual,
    activateSceneOnChannel: vi.fn(() => {
      throw new Error(SECRET);
    }),
  };
});

import scenesRoutes from '../../src/routes/scenes';

function app(): express.Express {
  const application = express();
  application.use(express.json());
  application.use('/api', scenesRoutes);
  return application;
}

describe('POST /api/scenes/activate error handling', () => {
  it('returns a 500 that names the failure without leaking the internal error string', async () => {
    const response = await request(app())
      .post('/api/scenes/activate')
      .send({ channelId: 'show-1', scene: { id: 'scene-1', name: 'Scene 1', elements: [] } });

    expect(response.status).toBe(500);
    expect(response.body.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Failed to activate scene',
    });
    // The client-facing body carries no internal detail: no `details` field and no raw error text.
    expect(response.body.error).not.toHaveProperty('details');
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
    expect(JSON.stringify(response.body)).not.toContain('Error:');
  });
});
