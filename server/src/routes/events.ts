import { Router, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { isValidChannelId } from '../validation/validator';
import { resolveTenant, channelKey } from '../tenancy';
import { dispatchActions, validateActions } from '../services/actionDispatcher';
import { ComponentAction } from '../types/element';
import { logger } from '../utils/logger';

const router = Router();

// Shared secret for the public webhook ingress. If unset, the webhook endpoint is
// DISABLED (returns 503) so it can never be an open door — opt-in only.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

/** Constant-time secret comparison (length-mismatch returns false up front). */
function secretMatches(provided: unknown): boolean {
  if (typeof provided !== 'string' || !WEBHOOK_SECRET) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(WEBHOOK_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * POST /api/events — local event ingress.
 * Body: { channelId, actions: ComponentAction[] }
 *
 * An overlay reports a fired trigger (e.g. countdown reached 0) here; the server
 * dispatches the actions so ALL subscribers react in sync. Same trust level as
 * the other /api mutating routes (same-origin overlay), so no secret required.
 */
router.post('/events', async (req: Request, res: Response) => {
  const tenantId = resolveTenant(req);
  const { channelId, actions } = req.body || {};

  if (!isValidChannelId(channelId)) {
    return res.status(400).json({ error: { code: 'INVALID_CHANNEL_ID', message: 'channelId must be a non-empty string (max 100 chars)' } });
  }
  const actionsError = validateActions(actions);
  if (actionsError) {
    return res.status(400).json({ error: { code: 'INVALID_ACTIONS', message: actionsError } });
  }

  const key = channelKey(tenantId, channelId);
  const result = await dispatchActions(key, channelId, tenantId, actions as ComponentAction[]);
  logger.info('Event dispatched', { tenantId, channelId, dispatched: result.dispatched, errors: result.errors.length });
  res.json({ data: { channelId, dispatched: result.dispatched, errors: result.errors } });
});

/**
 * POST /api/webhooks/:channel — remote/inbound webhook ingress.
 * Header: x-webhook-secret must equal WEBHOOK_SECRET (env).
 * Body: { actions: ComponentAction[] }  OR  { scene: "<collectionId>" } (shorthand).
 *
 * Lets an external service (a bot, a CRM, IFTTT, a game integration) drive the
 * same actions a local trigger would — change scenes, show/hide/update
 * components, play sounds. Secret-gated and disabled unless WEBHOOK_SECRET is set.
 */
router.post('/webhooks/:channel', async (req: Request, res: Response) => {
  if (!WEBHOOK_SECRET) {
    return res.status(503).json({ error: { code: 'WEBHOOKS_DISABLED', message: 'Set WEBHOOK_SECRET to enable webhook ingress' } });
  }
  if (!secretMatches(req.headers['x-webhook-secret'])) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'invalid or missing x-webhook-secret' } });
  }

  const tenantId = resolveTenant(req);
  const channelId = req.params.channel;
  if (!isValidChannelId(channelId)) {
    return res.status(400).json({ error: { code: 'INVALID_CHANNEL_ID', message: 'invalid channel' } });
  }

  // Shorthand: { scene: "<collectionId>" } => a single scene.activate action.
  let actions: unknown = req.body?.actions;
  if (!actions && typeof req.body?.scene === 'string') {
    actions = [{ kind: 'scene.activate', target: req.body.scene }];
  }
  const actionsError = validateActions(actions);
  if (actionsError) {
    return res.status(400).json({ error: { code: 'INVALID_ACTIONS', message: actionsError } });
  }

  const key = channelKey(tenantId, channelId);
  const result = await dispatchActions(key, channelId, tenantId, actions as ComponentAction[]);
  logger.info('Webhook dispatched', { tenantId, channelId, dispatched: result.dispatched, errors: result.errors.length });
  res.json({ data: { channelId, dispatched: result.dispatched, errors: result.errors } });
});

export default router;
