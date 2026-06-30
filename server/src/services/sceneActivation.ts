import { channelManager } from './ChannelManager';
import { validateElementNode } from '../validation/validator';
import { preserveTemplatesInElements } from '../utils/templatePreserver';
import { hoistCountdownTriggers } from '../utils/normalizeTriggers';
import { broadcastToChannel } from '../handlers/websocket';
import { Scene } from '../types/scene';

export interface ActivateResult {
  error?: { code: string; message: string; details?: unknown };
  elementCount?: number;
  subscriberCount?: number;
  variables?: Record<string, unknown>;
}

/**
 * Activate a scene on a channel: validate elements, set variables, replace
 * elements (preserving templates), set the active scene, clear any live
 * design-system override (the scene carries its own baked theme), and broadcast.
 * Shared by POST /scenes/activate and POST /collections/:id/activate.
 *
 * `key` is the realtime route key used for state and routing; `bareChannelId` is the plain channelId the client subscribed
 * with and is what goes in every broadcast message's `channelId` field — clients
 * filter incoming messages by the bare id, so the key must never leak into the
 * payload. For the default tenant the two are equal (self-hosted byte-identical).
 */
export function activateSceneOnChannel(
  key: string,
  bareChannelId: string,
  scene: Scene,
  variables?: Record<string, unknown>,
  clearPrevious = true
): ActivateResult {
  // Validate each scene element against the canonical element schema
  if (Array.isArray(scene.elements)) {
    for (const element of scene.elements) {
      const elementError = validateElementNode(element);
      if (elementError) return { error: elementError };
    }
  }

  const vars = (variables && typeof variables === 'object') ? (variables as Record<string, unknown>) : {};
  if (clearPrevious) {
    // Full swap: replace elements AND variables so the new scene starts clean and
    // no stale flag (e.g. a visibility flag a prior scene set false) carries over.
    channelManager.replaceVariables(key, vars);
    channelManager.clearElements(key);
  } else if (variables && typeof variables === 'object') {
    channelManager.setVariables(key, vars);
  }
  if (Array.isArray(scene.elements)) {
    // Hoist countdown.complete triggers onto each component's data-countdown element
    // (so "cuando la cuenta regresiva llega a 0 → ..." fires wherever it was attached),
    // then preserve template attributes. Both operate on clones — scene is untouched.
    for (const element of preserveTemplatesInElements(hoistCountdownTriggers(scene.elements))) {
      channelManager.addElement(key, element);
    }
  }

  channelManager.setActiveScene(key, scene);
  // Adopt the scene's canvas orientation (16:9 / 9:16); 'landscape' for legacy
  // scenes that predate the field.
  channelManager.setOrientation(key, scene.orientation ?? 'landscape');

  // The activated scene carries its own baked theme; drop any live design override.
  channelManager.clearDesignSystem(key);
  broadcastToChannel(key, { type: 'design.system', channelId: bareChannelId, designSystem: null });

  broadcastToChannel(key, {
    type: 'elements.updated',
    channelId: bareChannelId,
    elements: channelManager.getElements(key),
    variables: channelManager.getVariables(key),
    orientation: channelManager.getOrientation(key),
  });

  return {
    elementCount: scene.elements?.length || 0,
    subscriberCount: channelManager.getSubscriberCount(key),
    variables: channelManager.getVariables(key),
  };
}
