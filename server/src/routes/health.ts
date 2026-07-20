import { Router, Request, Response } from 'express';

const router = Router();
const startTime = Date.now();

/**
 * GET /health - Health check endpoint
 */
router.get('/health', (req: Request, res: Response) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);

  res.json({
    status: 'ok',
    uptime,
    timestamp: new Date().toISOString(),
  });
});

export default router;
