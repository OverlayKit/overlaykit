import { Router, type Request, type Response } from 'express';
import type { Storage } from '../storage';
import { resolveTenant } from '../tenancy';
import type { Scene } from '../types/scene';
import {
  ProductionError,
  type ProductionService,
} from '../services/ProductionService';

function respondWithError(res: Response, error: unknown): void {
  if (error instanceof ProductionError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Production operation failed' } });
}

export function createProductionRouter(storage: Storage, production: ProductionService): Router {
  const router = Router();

  async function showExists(req: Request, res: Response): Promise<boolean> {
    const show = await storage.getShow(req.params.showId);
    if (!show || show.archivedAt !== null) {
      res.status(404).json({ error: { code: 'SHOW_NOT_FOUND', message: 'Show not found' } });
      return false;
    }
    return true;
  }

  router.get('/shows/:showId/production', async (req: Request, res: Response) => {
    if (!await showExists(req, res)) return;
    res.json({ data: production.getState(req.params.showId) });
  });

  router.post('/shows/:showId/production/preview', async (req: Request, res: Response) => {
    if (!await showExists(req, res)) return;
    try {
      const scene = req.body?.scene as Scene;
      const variables = req.body?.variables && typeof req.body.variables === 'object'
        ? req.body.variables as Record<string, unknown>
        : {};
      res.json({ data: production.loadPreview(req.params.showId, scene, variables) });
    } catch (error) {
      respondWithError(res, error);
    }
  });

  router.post('/shows/:showId/production/preview/scenes/:sceneId', async (req: Request, res: Response) => {
    if (!await showExists(req, res)) return;
    const scene = await storage.getCollection(resolveTenant(req), req.params.sceneId);
    if (!scene || scene.channelId !== req.params.showId) {
      res.status(404).json({ error: { code: 'SCENE_NOT_FOUND', message: 'Scene not found in Show' } });
      return;
    }
    try {
      res.json({ data: production.loadPreview(req.params.showId, scene.scene, scene.variables) });
    } catch (error) {
      respondWithError(res, error);
    }
  });

  router.post('/shows/:showId/production/take', async (req: Request, res: Response) => {
    if (!await showExists(req, res)) return;
    const expectedPreviewRevision = req.body?.expectedPreviewRevision;
    const operationId = req.body?.operationId;
    if (!Number.isInteger(expectedPreviewRevision) || expectedPreviewRevision < 0) {
      res.status(400).json({
        error: { code: 'INVALID_PREVIEW_REVISION', message: 'expectedPreviewRevision must be a non-negative integer' },
      });
      return;
    }
    if (typeof operationId !== 'string') {
      res.status(400).json({ error: { code: 'INVALID_OPERATION_ID', message: 'operationId is required' } });
      return;
    }
    try {
      res.json({ data: production.take(req.params.showId, expectedPreviewRevision, operationId) });
    } catch (error) {
      respondWithError(res, error);
    }
  });

  return router;
}
