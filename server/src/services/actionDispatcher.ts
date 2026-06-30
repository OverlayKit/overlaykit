import { channelManager } from './ChannelManager';
import { broadcastToChannel } from '../handlers/websocket';
import { activateSceneOnChannel } from './sceneActivation';
import { channelKey } from '../tenancy';
import { storage } from '../storage';
import { logger } from '../utils/logger';
import { ComponentAction, ComponentActionKind } from '../types/element';

/**
 * Server-authoritative action dispatcher (Feature B). A component trigger
 * (countdown reaches 0, click, mounted) or a remote webhook resolves to a list
 * of actions; this dispatches them by reusing the SAME realtime paths the REST
 * routes use, so every subscriber on the channel reacts in sync. Local overlays
 * report triggers here rather than acting unilaterally, which also lets remote
 * webhooks drive the exact same actions.
 */

export const ACTION_KINDS: ComponentActionKind[] = [
  'scene.activate',
  'element.show',
  'element.hide',
  'element.update',
  'element.delete',
  'variables.update',
  'sound.play',
];

export const MAX_ACTIONS_PER_DISPATCH = 20;

export interface DispatchResult {
  dispatched: number;
  errors: string[];
}

/** Shallow runtime validation of an actions payload (kind enum + array cap). */
export function validateActions(actions: unknown): string | null {
  if (!Array.isArray(actions)) return 'actions must be an array';
  if (actions.length === 0) return 'actions must not be empty';
  if (actions.length > MAX_ACTIONS_PER_DISPATCH) return `too many actions (max ${MAX_ACTIONS_PER_DISPATCH})`;
  for (const a of actions) {
    if (!a || typeof a !== 'object') return 'each action must be an object';
    if (!ACTION_KINDS.includes((a as ComponentAction).kind)) return `unknown action kind: ${(a as ComponentAction).kind}`;
  }
  return null;
}

/**
 * Dispatch a list of actions on a realtime channel.
 * @param channelKeyId  the tenant-scoped realtime channel key (from channelKey()).
 * @param bareChannelId the plain source channelId — used in broadcast message
 *                      `channelId` fields (clients filter by the bare id, so the
 *                      tenant-scoped key must never leak into the payload).
 * @param tenantId      the resolved tenant (for collection lookups + scoping
 *                      cross-channel action targets).
 */
export async function dispatchActions(
  channelKeyId: string,
  bareChannelId: string,
  tenantId: string,
  actions: ComponentAction[]
): Promise<DispatchResult> {
  const errors: string[] = [];
  let dispatched = 0;

  for (const action of actions) {
    // An action may target a different channel than the source, but it stays
    // tenant-scoped: a raw action.channelId is namespaced through channelKey for
    // routing (`ch`) so it can never reach another tenant's realtime channel, while
    // `bareCh` is the un-namespaced id that goes in the broadcast message.
    const ch = action.channelId ? channelKey(tenantId, action.channelId) : channelKeyId;
    const bareCh = action.channelId || bareChannelId;
    try {
      switch (action.kind) {
        case 'scene.activate': {
          if (!action.target) { errors.push('scene.activate requires target (collection id)'); break; }
          const col = await storage.getCollection(tenantId, action.target);
          if (!col) { errors.push(`collection "${action.target}" not found`); break; }
          const r = activateSceneOnChannel(ch, bareCh, col.scene, col.variables, true);
          if (r.error) errors.push(r.error.message); else dispatched++;
          break;
        }
        case 'element.show':
        case 'element.hide': {
          if (!action.target) { errors.push(`${action.kind} requires target (element id)`); break; }
          const el = channelManager.getElement(ch, action.target);
          if (!el) { errors.push(`element "${action.target}" not found`); break; }
          const styles = { ...el.styles, display: action.kind === 'element.hide' ? 'none' : '' };
          channelManager.updateElement(ch, action.target, { styles });
          broadcastToChannel(ch, { type: 'element.update', channelId: bareCh, id: action.target, updates: { styles } });
          dispatched++;
          break;
        }
        case 'element.update': {
          if (!action.target) { errors.push('element.update requires target (element id)'); break; }
          const updates = action.updates || {};
          const updated = channelManager.updateElement(ch, action.target, updates);
          if (!updated) { errors.push(`element "${action.target}" not found`); break; }
          broadcastToChannel(ch, { type: 'element.update', channelId: bareCh, id: action.target, updates });
          dispatched++;
          break;
        }
        case 'element.delete': {
          if (!action.target) { errors.push('element.delete requires target (element id)'); break; }
          const ok = channelManager.deleteElement(ch, action.target);
          if (!ok) { errors.push(`element "${action.target}" not found`); break; }
          broadcastToChannel(ch, { type: 'element.delete', channelId: bareCh, id: action.target });
          dispatched++;
          break;
        }
        case 'variables.update': {
          if (!action.variables || typeof action.variables !== 'object') { errors.push('variables.update requires variables'); break; }
          channelManager.setVariables(ch, action.variables as Record<string, unknown>);
          broadcastToChannel(ch, { type: 'variables.update', channelId: bareCh, variables: channelManager.getVariables(ch) });
          dispatched++;
          break;
        }
        case 'sound.play': {
          if (!action.sound || !action.sound.url) { errors.push('sound.play requires sound.url'); break; }
          broadcastToChannel(ch, { type: 'sound.play', channelId: bareCh, sound: action.sound });
          dispatched++;
          break;
        }
        default:
          errors.push(`unknown action kind: ${(action as ComponentAction).kind}`);
      }
    } catch (e) {
      errors.push(String(e));
    }
  }

  logger.debug('Actions dispatched', { channel: channelKeyId, dispatched, errorCount: errors.length });
  return { dispatched, errors };
}
