import { Router, Request, Response } from 'express';
import { channelManager } from '../services/ChannelManager';
import { broadcastToChannel } from '../handlers/websocket';
import { isValidChannelId } from '../validation/validator';
import { resolveTenant, channelKey } from '../tenancy';
import { tokensToCss, sanitizeTokens } from '../utils/designTokens';
import { logger } from '../utils/logger';

const router = Router();

/**
 * POST /api/design-systems
 * Body: { channelId, name, tokens }
 *
 * Stores a design system (theme tokens) for a channel and broadcasts it live to
 * all subscribers (composer + overlay) so DS components re-skin without
 * re-activating the scene. This endpoint accepts generated or hand-authored
 * design-system tokens.
 */
router.post('/design-systems', (req: Request, res: Response) => {
  const { channelId = 'main', name, tokens } = req.body || {};

  if (!isValidChannelId(channelId)) {
    return res.status(400).json({ error: { code: 'INVALID_CHANNEL_ID', message: 'channelId must be a non-empty string (max 100 chars)' } });
  }
  if (!tokens || typeof tokens !== 'object') {
    return res.status(400).json({ error: { code: 'INVALID_TOKENS', message: 'tokens must be an object of design-token values' } });
  }

  const clean = sanitizeTokens(tokens);
  if (Object.keys(clean).length === 0) {
    return res.status(400).json({ error: { code: 'EMPTY_TOKENS', message: 'No recognized design tokens were provided' } });
  }

  const designSystem = {
    name: (typeof name === 'string' && name.trim()) || clean.name || 'Tema',
    tokens: clean,
    css: tokensToCss(clean),
  };

  const key = channelKey(resolveTenant(req), channelId);
  channelManager.setDesignSystem(key, designSystem);
  logger.info('Design system applied', { channelId, name: designSystem.name, tokens: Object.keys(clean).length });

  broadcastToChannel(key, { type: 'design.system', channelId, designSystem });

  res.json({
    data: {
      channelId,
      name: designSystem.name,
      subscriberCount: channelManager.getSubscriberCount(key),
      message: 'Design system applied',
    },
  });
});

/**
 * GET /api/design-systems?channelId=main — current design system for a channel.
 */
router.get('/design-systems', (req: Request, res: Response) => {
  const channelId = (req.query.channelId as string) || 'main';
  if (!isValidChannelId(channelId)) {
    return res.status(400).json({ error: { code: 'INVALID_CHANNEL_ID', message: 'invalid channelId' } });
  }
  const key = channelKey(resolveTenant(req), channelId);
  res.json({ data: { channelId, designSystem: channelManager.getDesignSystem(key) || null } });
});

export default router;
