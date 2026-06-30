import { Router, Request, Response } from 'express';
import { channelManager } from '../services/ChannelManager';
import { validateVariables, isValidChannelId } from '../validation/validator';
import { resolveTenant, channelKey } from '../tenancy';
import { logger } from '../utils/logger';
import { broadcastToChannel } from '../handlers/websocket';

const router = Router();

/**
 * POST /api/variables - Update variables for a channel
 */
router.post('/variables', (req: Request, res: Response) => {
  const { channelId, variables } = req.body;

  // Validate channel ID
  if (!isValidChannelId(channelId)) {
    return res.status(400).json({
      error: {
        code: 'INVALID_CHANNEL_ID',
        message: 'channelId must be a non-empty string (max 100 chars)',
      },
    });
  }

  // Validate variables
  if (!variables || typeof variables !== 'object') {
    return res.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'variables must be an object',
      },
    });
  }

  // Validate variable structure
  const validationError = validateVariables(variables);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    const key = channelKey(resolveTenant(req), channelId);
    channelManager.setVariables(key, variables);
    logger.debug('Variables updated', { channelId, variableCount: Object.keys(variables).length });

    // Broadcast the FULL merged set (not the partial request body): the server
    // deep-merges into the store, but subscribers merge incoming updates shallowly,
    // so sending only the partial would let a nested push (e.g. { user: { role } } or
    // { flags: { live } }) clobber sibling keys (user.name, flags.show_*) on the client.
    // Mirrors actionDispatcher's variables.update broadcast.
    broadcastToChannel(key, {
      type: 'variables.update',
      channelId,
      variables: channelManager.getVariables(key),
    });

    res.json({
      data: {
        message: 'Variables updated',
        count: Object.keys(variables).length,
      },
    });
  } catch (error) {
    logger.error('Error updating variables', { error: String(error) });
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update variables',
      },
    });
  }
});

export default router;
