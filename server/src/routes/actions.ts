import { Router, Request, Response } from 'express';
import { storage, ActionRecord } from '../storage';
import { isValidChannelId } from '../validation/validator';
import { resolveTenant, channelKey } from '../tenancy';
import { dispatchActions, validateActions } from '../services/actionDispatcher';
import { ComponentAction } from '../types/element';
import { logger } from '../utils/logger';

const router = Router();

function slug(name: string): string {
  return 'act-' + name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** GET /api/actions — list saved action bundles. */
router.get('/actions', async (req: Request, res: Response) => {
  const tenantId = resolveTenant(req);
  const actions = await storage.listActions(tenantId);
  res.json({ data: { actions } });
});

/** GET /api/actions/:id — full saved action bundle. */
router.get('/actions/:id', async (req: Request, res: Response) => {
  const action = await storage.getAction(resolveTenant(req), req.params.id);
  if (!action) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Action not found' } });
  res.json({ data: action });
});

/**
 * POST /api/actions — save (upsert) a named action bundle.
 * Body: { id?, name, channelId?, icon?, actions }
 */
router.post('/actions', async (req: Request, res: Response) => {
  const tenantId = resolveTenant(req);
  const { id, name, channelId, icon, actions } = req.body || {};

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: { code: 'INVALID_NAME', message: 'name is required' } });
  }
  const actionsError = validateActions(actions);
  if (actionsError) {
    return res.status(400).json({ error: { code: 'INVALID_ACTIONS', message: actionsError } });
  }

  const record: ActionRecord = {
    id: (typeof id === 'string' && id) || slug(name),
    tenantId,
    name,
    icon: (typeof icon === 'string' && icon) || undefined,
    channelId: (typeof channelId === 'string' && channelId) || undefined,
    actions: actions as ComponentAction[],
    updatedAt: Date.now(),
  };
  await storage.saveAction(record);
  logger.info('Action saved', { tenantId, id: record.id, name: record.name, actions: record.actions.length });
  res.status(201).json({ data: { id: record.id, name: record.name } });
});

/** DELETE /api/actions/:id */
router.delete('/actions/:id', async (req: Request, res: Response) => {
  const ok = await storage.deleteAction(resolveTenant(req), req.params.id);
  if (!ok) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Action not found' } });
  res.json({ data: { id: req.params.id, deleted: true } });
});

/**
 * POST /api/actions/:id/run — run a saved action bundle by id.
 * Body: { channelId? } overrides the stored channel for panel/webhook triggers.
 */
router.post('/actions/:id/run', async (req: Request, res: Response) => {
  const tenantId = resolveTenant(req);
  const record = await storage.getAction(tenantId, req.params.id);
  if (!record) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Action not found' } });

  const channelId = (req.body && req.body.channelId) || record.channelId || 'main';
  if (!isValidChannelId(channelId)) {
    return res.status(400).json({ error: { code: 'INVALID_CHANNEL_ID', message: 'invalid channelId' } });
  }

  // Scope the realtime channel to the local instance (no-op for the default local instance).
  const key = channelKey(tenantId, channelId);
  const result = await dispatchActions(key, channelId, tenantId, record.actions);
  logger.info('Action run by id', { tenantId, id: record.id, channelId, dispatched: result.dispatched, errors: result.errors.length });
  res.json({ data: { id: record.id, channelId, dispatched: result.dispatched, errors: result.errors } });
});

export default router;
