import { Router, Request, Response } from 'express';
import { channelManager } from '../services/ChannelManager';
import { validateSceneNode, isValidChannelId } from '../validation/validator';
import { resolveTenant, channelKey } from '../tenancy';
import { logger } from '../utils/logger';
import { broadcastToChannel } from '../handlers/websocket';
import { Scene } from '../types/scene';
import { activateSceneOnChannel } from '../services/sceneActivation';

const router = Router();

/**
 * POST /api/scenes - Create a scene
 */
router.post('/scenes', (req: Request, res: Response) => {
  const { channelId, scene } = req.body;

  // Validate channel ID
  if (!isValidChannelId(channelId)) {
    return res.status(400).json({
      error: {
        code: 'INVALID_CHANNEL_ID',
        message: 'channelId must be a non-empty string (max 100 chars)',
      },
    });
  }

  // Validate scene
  const validationError = validateSceneNode(scene);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    channelManager.setActiveScene(channelKey(resolveTenant(req), channelId), scene as Scene);
    logger.debug('Scene created', { channelId, sceneId: scene.id });

    res.status(201).json({
      data: {
        id: scene.id,
        message: 'Scene created',
      },
    });
  } catch (error) {
    logger.error('Error creating scene', { error: String(error) });
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create scene',
      },
    });
  }
});

/**
 * POST /api/scenes/activate - Activate a scene directly (for dashboard)
 */
router.post('/scenes/activate', (req: Request, res: Response) => {
  const { channelId, scene, variables, clearPrevious = true } = req.body;

  // Validate channel ID
  if (!isValidChannelId(channelId)) {
    return res.status(400).json({
      error: {
        code: 'INVALID_CHANNEL_ID',
        message: 'channelId must be a non-empty string (max 100 chars)',
      },
    });
  }

  // Validate scene
  if (!scene || !scene.id || !scene.name) {
    return res.status(400).json({
      error: {
        code: 'INVALID_SCENE',
        message: 'Scene must have id and name',
      },
    });
  }

  try {
    const key = channelKey(resolveTenant(req), channelId);
    const result = activateSceneOnChannel(key, channelId, scene as Scene, variables, clearPrevious);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    logger.info('Scene activated via API', {
      channelId,
      sceneId: scene.id,
      elementsCount: scene.elements?.length || 0
    });

    res.json({
      data: {
        id: scene.id,
        name: scene.name,
        message: 'Scene activated successfully',
        elementCount: result.elementCount,
        subscriberCount: result.subscriberCount,
        variables: result.variables
      },
    });
  } catch (error) {
    logger.error('Error activating scene via API', { error: String(error) });
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to activate scene',
        details: String(error)
      },
    });
  }
});

/**
 * POST /api/scenes/:sceneId/activate - Activate a scene
 */
router.post('/scenes/:sceneId/activate', (req: Request, res: Response) => {
  const { sceneId } = req.params;
  const { channelId, clearPrevious = false } = req.body;

  // Validate channel ID
  if (!isValidChannelId(channelId)) {
    return res.status(400).json({
      error: {
        code: 'INVALID_CHANNEL_ID',
        message: 'channelId must be a non-empty string (max 100 chars)',
      },
    });
  }

  try {
    const key = channelKey(resolveTenant(req), channelId);
    const activeScene = channelManager.getActiveScene(key);

    if (!activeScene) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: `Scene not found in channel "${channelId}"`,
        },
      });
    }

    // If clearPrevious is true, remove all existing elements
    if (clearPrevious) {
      channelManager.clearElements(key);
      logger.debug('Elements cleared', { channelId });
    }

    // Add all scene elements to the channel
    if (activeScene.elements) {
      for (const element of activeScene.elements) {
        channelManager.addElement(key, element);
      }
    }

    logger.debug('Scene activated', { channelId, sceneId });

    // Broadcast scene activation to subscribers (routing by key, bare channelId
    // in the payload so subscribers' channelId filter matches).
    broadcastToChannel(key, {
      type: 'scene.activated' as const,
      channelId,
      scene: activeScene,
      variables: channelManager.getVariables(key)
    });

    res.json({
      data: {
        id: sceneId,
        message: 'Scene activated',
        elementCount: activeScene.elements?.length || 0,
      },
    });
  } catch (error) {
    logger.error('Error activating scene', { error: String(error) });
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to activate scene',
      },
    });
  }
});

export default router;
