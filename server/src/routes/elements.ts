import { Router, Request, Response } from 'express';
import { channelManager } from '../services/ChannelManager';
import { validateElementNode, isValidChannelId } from '../validation/validator';
import { resolveTenant, channelKey } from '../tenancy';
import { logger } from '../utils/logger';
import { broadcastToChannel } from '../handlers/websocket';
import { ElementNode } from '../types/element';

const router = Router();

// First non-empty text content anywhere in a subtree (used to label a component).
// Skips <style>/<script> nodes so the label is real text, not a CSS rule.
function firstText(el: ElementNode): string {
  if (el.tag === 'style' || el.tag === 'script') return '';
  if (typeof el.content === 'string' && el.content.trim()) return el.content.trim();
  if (Array.isArray(el.children)) {
    for (const c of el.children) {
      const t = firstText(c);
      if (t) return t;
    }
  }
  return '';
}

// Minimal {{a.b}} interpolation against the channel's variables, so a component's
// label reads "¿En qué año…" instead of the raw "{{quiz.question}}" token.
function interpolateLabel(text: string, vars: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const v = path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), vars);
    return v == null ? '' : String(v);
  });
}

function elementLabel(el: ElementNode, vars: Record<string, unknown>): string {
  const t = interpolateLabel(firstText(el), vars).trim();
  if (t && !/^\{\{.*\}\}$/.test(t)) return t.length > 40 ? t.slice(0, 40) + '…' : t;
  return (el.attributes?.class as string | undefined) || el.id;
}

/**
 * GET /api/elements?channelId=... — list the LIVE top-level components of the
 * active scene on a channel, each with a friendly (interpolated) label and current
 * hidden state. Powers the element.show/hide/update/delete target pickers in the
 * editor so the operator selects a real component instead of typing an id.
 */
router.get('/elements', (req: Request, res: Response) => {
  const channelId = req.query.channelId as string;
  if (!isValidChannelId(channelId)) {
    return res.status(400).json({
      error: { code: 'INVALID_CHANNEL_ID', message: 'channelId query param is required (non-empty, max 100 chars)' },
    });
  }
  const key = channelKey(resolveTenant(req), channelId);
  const vars = channelManager.getVariables(key) as Record<string, unknown>;
  const elements = channelManager
    .getElements(key)
    .filter((e) => e.tag !== 'style' && e.tag !== 'script')
    .map((e) => ({ id: e.id, label: elementLabel(e, vars), hidden: (e.styles?.display ?? '') === 'none' }));
  res.json({ data: { elements } });
});

/**
 * POST /api/elements - Create a new element
 */
router.post('/elements', (req: Request, res: Response) => {
  const { channelId, element } = req.body;

  // Validate channel ID
  if (!isValidChannelId(channelId)) {
    return res.status(400).json({
      error: {
        code: 'INVALID_CHANNEL_ID',
        message: 'channelId must be a non-empty string (max 100 chars)',
      },
    });
  }

  // Validate element
  const validationError = validateElementNode(element);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    const key = channelKey(resolveTenant(req), channelId);
    channelManager.addElement(key, element as ElementNode);
    logger.debug('Element created', { channelId, elementId: element.id });

    // Broadcast to subscribers (route by key, bare channelId in the payload)
    broadcastToChannel(key, {
      type: 'element.create',
      channelId,
      element: element as ElementNode,
    });

    res.status(201).json({
      data: { id: element.id, message: 'Element created' },
    });
  } catch (error) {
    logger.error('Error creating element', { error: String(error) });
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create element',
      },
    });
  }
});

/**
 * PUT /api/elements/:id - Update an element
 */
router.put('/elements/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const { channelId, updates } = req.body;

  // Validate channel ID
  if (!isValidChannelId(channelId)) {
    return res.status(400).json({
      error: {
        code: 'INVALID_CHANNEL_ID',
        message: 'channelId must be a non-empty string (max 100 chars)',
      },
    });
  }

  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'updates must be an object',
      },
    });
  }

  try {
    const key = channelKey(resolveTenant(req), channelId);
    const updated = channelManager.updateElement(key, id, updates);

    if (!updated) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: `Element with id "${id}" not found in channel "${channelId}"`,
        },
      });
    }

    logger.debug('Element updated', { channelId, elementId: id });

    // Broadcast to subscribers (route by key, bare channelId in the payload)
    broadcastToChannel(key, {
      type: 'element.update',
      channelId,
      id,
      updates,
    });

    res.json({ data: { id, message: 'Element updated' } });
  } catch (error) {
    logger.error('Error updating element', { error: String(error) });
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update element',
      },
    });
  }
});

/**
 * DELETE /api/elements/:id - Delete an element
 */
router.delete('/elements/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const { channelId } = req.body;

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
    const deleted = channelManager.deleteElement(key, id);

    if (!deleted) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: `Element with id "${id}" not found in channel "${channelId}"`,
        },
      });
    }

    logger.debug('Element deleted', { channelId, elementId: id });

    // Broadcast to subscribers (route by key, bare channelId in the payload)
    broadcastToChannel(key, {
      type: 'element.delete',
      channelId,
      id,
    });

    res.json({ data: { id, message: 'Element deleted' } });
  } catch (error) {
    logger.error('Error deleting element', { error: String(error) });
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete element',
      },
    });
  }
});

/**
 * POST /api/elements/toggle-visibility - Show/hide the index-th visual component.
 * Body: { channelId, index }. Server-authoritative: flips styles.display none<->''
 * on the index-th non-style element (top-level order) and broadcasts the merged
 * styles, so position/zIndex are preserved. Useful for panel hide/show controls.
 */
router.post('/elements/toggle-visibility', (req: Request, res: Response) => {
  const { channelId, index } = req.body;

  if (!isValidChannelId(channelId)) {
    return res.status(400).json({
      error: { code: 'INVALID_CHANNEL_ID', message: 'channelId must be a non-empty string (max 100 chars)' },
    });
  }

  const key = channelKey(resolveTenant(req), channelId);
  const visual = channelManager.getElements(key).filter((e) => e.tag !== 'style');
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= visual.length) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: `No component at index ${index} (channel has ${visual.length})` },
    });
  }

  const el = visual[i];
  const willHide = (el.styles?.display ?? '') !== 'none';
  const styles = { ...el.styles, display: willHide ? 'none' : '' };
  channelManager.updateElement(key, el.id, { styles });

  broadcastToChannel(key, { type: 'element.update', channelId, id: el.id, updates: { styles } });

  logger.debug('Component visibility toggled', { channelId, index: i, id: el.id, hidden: willHide });
  res.json({ data: { index: i, id: el.id, hidden: willHide, total: visual.length } });
});

export default router;
