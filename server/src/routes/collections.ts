import { Router, Request, Response } from 'express';
import { storage, CollectionRecord } from '../storage';
import { activateSceneOnChannel } from '../services/sceneActivation';
import { channelManager } from '../services/ChannelManager';
import { isValidChannelId } from '../validation/validator';
import { resolveTenant, channelKey } from '../tenancy';
import { logger } from '../utils/logger';
import { Scene } from '../types/scene';

const router = Router();

function slug(name: string): string {
  return 'col-' + name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** GET /api/collections — list saved collections (optionally by channel). */
router.get('/collections', async (req: Request, res: Response) => {
  const tenantId = resolveTenant(req);
  const channelId = req.query.channelId as string | undefined;
  let items = await storage.listCollections(tenantId);
  if (channelId) items = items.filter((c) => c.channelId === channelId);
  res.json({ data: { collections: items } });
});

/** GET /api/collections/:id — full saved collection. */
router.get('/collections/:id', async (req: Request, res: Response) => {
  const col = await storage.getCollection(resolveTenant(req), req.params.id);
  if (!col) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Collection not found' } });
  res.json({ data: col });
});

/**
 * POST /api/collections — save (upsert) a built collection.
 * Body: { id?, name, channelId, scene, variables }
 */
router.post('/collections', async (req: Request, res: Response) => {
  const tenantId = resolveTenant(req);
  const { id, name, channelId, scene, variables } = req.body || {};

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: { code: 'INVALID_NAME', message: 'name is required' } });
  }
  if (!isValidChannelId(channelId)) {
    return res.status(400).json({ error: { code: 'INVALID_CHANNEL_ID', message: 'channelId must be a non-empty string (max 100 chars)' } });
  }
  if (!scene || !scene.id || !scene.name || !Array.isArray(scene.elements)) {
    return res.status(400).json({ error: { code: 'INVALID_SCENE', message: 'scene must have id, name and elements[]' } });
  }

  const record: CollectionRecord = {
    id: (typeof id === 'string' && id) || slug(name),
    tenantId,
    name,
    channelId,
    scene: scene as Scene,
    variables: (variables && typeof variables === 'object') ? variables : {},
    updatedAt: Date.now(),
  };
  await storage.saveCollection(record);
  logger.info('Collection saved', { tenantId, id: record.id, name: record.name, elements: record.scene.elements?.length || 0 });
  res.status(201).json({ data: { id: record.id, name: record.name } });
});

/** DELETE /api/collections/:id */
router.delete('/collections/:id', async (req: Request, res: Response) => {
  const ok = await storage.deleteCollection(resolveTenant(req), req.params.id);
  if (!ok) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Collection not found' } });
  res.json({ data: { id: req.params.id, deleted: true } });
});

/**
 * POST /api/collections/:id/activate — activate a saved collection by id.
 * Body: { channelId? } overrides the stored channel for panel/webhook triggers.
 */
router.post('/collections/:id/activate', async (req: Request, res: Response) => {
  const tenantId = resolveTenant(req);
  const col = await storage.getCollection(tenantId, req.params.id);
  if (!col) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Collection not found' } });

  const channelId = (req.body && req.body.channelId) || col.channelId;
  if (!isValidChannelId(channelId)) {
    return res.status(400).json({ error: { code: 'INVALID_CHANNEL_ID', message: 'invalid channelId' } });
  }

  // the bare channelId is what subscribers see in the broadcast payload.
  const key = channelKey(tenantId, channelId);
  const result = activateSceneOnChannel(key, channelId, col.scene, col.variables, true);
  if (result.error) return res.status(400).json({ error: result.error });

  logger.info('Collection activated by id', { tenantId, id: col.id, channelId, elements: result.elementCount });
  res.json({
    data: {
      id: col.id,
      name: col.name,
      channelId,
      message: 'Collection activated',
      elementCount: result.elementCount,
      subscriberCount: channelManager.getSubscriberCount(key),
    },
  });
});

export default router;
