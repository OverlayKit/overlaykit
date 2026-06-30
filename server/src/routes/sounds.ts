import { Router, Request, Response } from 'express';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { isValidChannelId } from '../validation/validator';
import { resolveTenant, channelKey } from '../tenancy';
import { broadcastToChannel } from '../handlers/websocket';
import { logger } from '../utils/logger';

const router = Router();

// The bundled starter catalog manifest, generated offline by scripts/gen-tones.mjs.
// Read at request time (not cached) so a regenerated manifest is picked up without
// a server restart — the catalog is small so the per-request read is cheap.
const MANIFEST_PATH = join(__dirname, '..', '..', 'public', 'sounds', 'manifest.json');

interface SoundEntry {
  id: string;
  name: string;
  category: string;
  url: string;
  durationMs: number;
  attribution: string;
}

/**
 * GET /api/sounds — the bundled, royalty-free starter sound catalog.
 *
 * Powers the editor SoundPicker, the panel soundboard, and saved sound actions.
 * Reads the generated manifest at request time. If the manifest is missing
 * (script never run), returns an empty list rather than 500 so the UI degrades
 * gracefully to "no built-in sounds" instead of erroring.
 */
router.get('/sounds', async (_req: Request, res: Response) => {
  try {
    const raw = await readFile(MANIFEST_PATH, 'utf-8');
    const sounds = JSON.parse(raw) as SoundEntry[];
    res.json({ data: { sounds } });
  } catch (error) {
    logger.warn('Sound manifest unavailable, serving empty catalog', { error: String(error) });
    res.json({ data: { sounds: [] } });
  }
});

/**
 * POST /api/sounds/play — trigger a one-shot sound on a channel.
 * Body: { channelId, sound: { url, volume?, loop? } }
 *
 * Reuses the EXISTING realtime sound.play message that the overlay already plays
 * (the same one actionDispatcher emits), so a soundboard button or action run
 * makes every subscriber on the channel hear it in sync. Tenant-scoped via
 * channelKey, matching the convention in routes/events.ts.
 */
router.post('/sounds/play', (req: Request, res: Response) => {
  const tenantId = resolveTenant(req);
  const { channelId, sound } = req.body || {};

  if (!isValidChannelId(channelId)) {
    return res.status(400).json({
      error: { code: 'INVALID_CHANNEL_ID', message: 'channelId must be a non-empty string (max 100 chars)' },
    });
  }
  if (!sound || typeof sound !== 'object' || typeof sound.url !== 'string') {
    return res.status(400).json({
      error: { code: 'INVALID_SOUND', message: 'sound.url must be a string' },
    });
  }

  const key = channelKey(tenantId, channelId);
  broadcastToChannel(key, { type: 'sound.play', channelId, sound });
  logger.info('Sound played', { tenantId, channelId, url: sound.url });
  res.json({ data: { played: true } });
});

export default router;
