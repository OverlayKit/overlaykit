import { randomUUID } from 'crypto';
import { Router, type Request, type Response } from 'express';
import type { Storage } from '../storage';

function normalizedName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length >= 2 && name.length <= 100 ? name : null;
}

function normalizedDescription(value: unknown): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const description = value.trim();
  return description.length <= 500 ? description : null;
}

function invalidShow(res: Response): void {
  res.status(400).json({
    error: {
      code: 'INVALID_SHOW',
      message: 'Show name must be 2 to 100 characters and description at most 500 characters',
    },
  });
}

export function createShowsRouter(storage: Storage): Router {
  const router = Router();

  router.get('/shows', async (req: Request, res: Response) => {
    const includeArchived = req.query.archived === 'true';
    res.json({ data: await storage.listShows(includeArchived) });
  });

  router.post('/shows', async (req: Request, res: Response) => {
    const name = normalizedName(req.body?.name);
    const description = normalizedDescription(req.body?.description);
    if (!name || description === null) return invalidShow(res);
    const now = Date.now();
    const show = await storage.saveShow({
      id: randomUUID(),
      name,
      description,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    res.status(201).json({ data: show });
  });

  router.get('/shows/:id', async (req: Request, res: Response) => {
    const show = await storage.getShow(req.params.id);
    if (!show) {
      res.status(404).json({ error: { code: 'SHOW_NOT_FOUND', message: 'Show not found' } });
      return;
    }
    res.json({ data: show });
  });

  router.put('/shows/:id', async (req: Request, res: Response) => {
    const current = await storage.getShow(req.params.id);
    if (!current) {
      res.status(404).json({ error: { code: 'SHOW_NOT_FOUND', message: 'Show not found' } });
      return;
    }
    const name = normalizedName(req.body?.name ?? current.name);
    const description = normalizedDescription(req.body?.description ?? current.description);
    if (!name || description === null) return invalidShow(res);
    const show = await storage.saveShow({
      ...current,
      name,
      description,
      updatedAt: Date.now(),
    });
    res.json({ data: show });
  });

  router.delete('/shows/:id', async (req: Request, res: Response) => {
    const show = await storage.archiveShow(req.params.id, Date.now());
    if (!show) {
      res.status(404).json({ error: { code: 'SHOW_NOT_FOUND', message: 'Show not found' } });
      return;
    }
    res.json({ data: show });
  });

  return router;
}
