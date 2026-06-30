import { Router, Request, Response } from 'express';
import { channelManager } from '../services/ChannelManager';

const router = Router();
const startTime = Date.now();

/**
 * GET /health - Health check endpoint
 */
router.get('/health', (req: Request, res: Response) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const activeChannels = channelManager.getActiveChannels();
  const totalSubscribers = activeChannels.reduce(
    (sum, channelId) => sum + channelManager.getSubscriberCount(channelId),
    0
  );

  res.json({
    status: 'ok',
    uptime,
    timestamp: new Date().toISOString(),
    channels: {
      active: activeChannels.length,
      list: activeChannels,
    },
    subscribers: {
      total: totalSubscribers,
    },
  });
});

export default router;
