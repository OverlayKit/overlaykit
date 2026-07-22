import { WebSocket } from 'ws';
import { ElementNode } from '../types/element';
import { Scene, Orientation } from '../types/scene';
import { ServerMessage } from '../types/messages';

export interface DesignSystem {
  name: string;
  tokens: Record<string, string>;
  css: string;
}

// Channel variables are nested by design (e.g. { user: { name }, flags: { live } }),
// so the store carries arbitrary JSON values, not just scalars.
export type VariableBag = Record<string, unknown>;

export interface ChannelState {
  elements: Map<string, ElementNode>;
  variables: VariableBag;
  activeScene?: Scene;
  designSystem?: DesignSystem;
  // Canvas orientation of the active scene. Drives 16:9 vs 9:16 in every
  // preview and in the output; defaults to landscape until a scene sets it.
  orientation: Orientation;
  subscribers: Set<WebSocket>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Recursively merge `source` into `target`, returning a new object. Plain objects
 * are merged key-by-key (so { flags: { live } } merges INTO { flags: { show_x } }
 * instead of replacing the whole `flags` object); scalars, arrays and null are
 * leaves that overwrite. This is what keeps a live `flags.live` push from wiping
 * the `flags.show_*` visibility flags the editor/panel set independently.
 */
function deepMerge(target: VariableBag, source: VariableBag): VariableBag {
  const out: VariableBag = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = out[key];
    out[key] = isPlainObject(sv) && isPlainObject(tv) ? deepMerge(tv, sv) : sv;
  }
  return out;
}

export class ChannelManager {
  private channels: Map<string, ChannelState> = new Map();
  // Ephemeral last-activity timestamp per channel key (subscribe + broadcast).
  // Feeds the Show live/lastActive projection without persisting ChannelState;
  // survives a channel going empty so "last live 5m ago" still reads true.
  private lastActivity: Map<string, number> = new Map();

  /**
   * Get or create a channel
   */
  public getOrCreateChannel(channelId: string): ChannelState {
    if (!this.channels.has(channelId)) {
      this.channels.set(channelId, {
        elements: new Map(),
        variables: {},
        orientation: 'landscape',
        subscribers: new Set(),
      });
    }
    return this.channels.get(channelId)!;
  }

  /**
   * Subscribe a WebSocket connection to a channel
   */
  public subscribe(channelId: string, ws: WebSocket): void {
    const channel = this.getOrCreateChannel(channelId);
    channel.subscribers.add(ws);
    this.lastActivity.set(channelId, Date.now());
  }

  /**
   * Unsubscribe a WebSocket connection from a channel
   */
  public unsubscribe(channelId: string, ws: WebSocket): void {
    const channel = this.channels.get(channelId);
    if (channel) {
      channel.subscribers.delete(ws);
      // Clean up empty channels
      if (channel.subscribers.size === 0) {
        this.channels.delete(channelId);
      }
    }
  }

  /**
   * Unsubscribe a connection from all channels
   */
  public unsubscribeFromAll(ws: WebSocket): void {
    for (const [, channel] of this.channels) {
      channel.subscribers.delete(ws);
    }
    // Clean up empty channels
    for (const [channelId, channel] of this.channels) {
      if (channel.subscribers.size === 0) {
        this.channels.delete(channelId);
      }
    }
  }

  /**
   * Broadcast a message to all subscribers of a channel
   */
  public broadcast(channelId: string, message: ServerMessage): void {
    const channel = this.channels.get(channelId);
    if (!channel) {
      return;
    }
    this.lastActivity.set(channelId, Date.now());

    const messageStr = JSON.stringify(message);

    for (const subscriber of channel.subscribers) {
      if (subscriber.readyState === WebSocket.OPEN) {
        try {
          subscriber.send(messageStr);
        } catch {
          // Ignore send errors for individual subscribers
        }
      }
    }
  }

  /**
   * Add an element to a channel
   */
  public addElement(channelId: string, element: ElementNode): void {
    const channel = this.getOrCreateChannel(channelId);
    channel.elements.set(element.id, element);
  }

  /**
   * Get an element from a channel
   */
  public getElement(channelId: string, elementId: string): ElementNode | undefined {
    const channel = this.channels.get(channelId);
    return channel?.elements.get(elementId);
  }

  /**
   * Update an element in a channel
   */
  public updateElement(
    channelId: string,
    elementId: string,
    updates: Partial<ElementNode>
  ): ElementNode | null {
    const channel = this.channels.get(channelId);
    if (!channel) return null;

    const element = channel.elements.get(elementId);
    if (!element) return null;

    const updated = { ...element, ...updates };
    channel.elements.set(elementId, updated);
    return updated;
  }

  /**
   * Delete an element from a channel
   */
  public deleteElement(channelId: string, elementId: string): boolean {
    const channel = this.channels.get(channelId);
    if (!channel) return false;
    return channel.elements.delete(elementId);
  }

  /**
   * Get all elements in a channel
   */
  public getElements(channelId: string): ElementNode[] {
    const channel = this.channels.get(channelId);
    if (!channel) return [];
    return Array.from(channel.elements.values());
  }

  /**
   * Clear all elements in a channel
   */
  public clearElements(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (channel) {
      channel.elements.clear();
    }
  }

  /**
   * Set variables for a channel (deep-merged into the existing bag so a partial
   * push only touches the paths it carries — see deepMerge).
   */
  public setVariables(channelId: string, variables: VariableBag): void {
    const channel = this.getOrCreateChannel(channelId);
    channel.variables = deepMerge(channel.variables, variables);
  }

  /**
   * Replace the entire variable bag (used on a full scene swap with clearPrevious,
   * so a flag a prior scene set — e.g. flags.show_hero=false — doesn't linger and
   * leak a stale hidden state into the next scene that reuses a colliding id).
   */
  public replaceVariables(channelId: string, variables: VariableBag): void {
    const channel = this.getOrCreateChannel(channelId);
    channel.variables = { ...variables };
  }

  /**
   * Get variables for a channel
   */
  public getVariables(channelId: string): VariableBag {
    const channel = this.channels.get(channelId);
    return channel?.variables || {};
  }

  /**
   * Set the active scene for a channel
   */
  public setActiveScene(channelId: string, scene: Scene): void {
    const channel = this.getOrCreateChannel(channelId);
    channel.activeScene = scene;
  }

  public clearActiveScene(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (channel) channel.activeScene = undefined;
  }

  /**
   * Get the active scene for a channel
   */
  public getActiveScene(channelId: string): Scene | undefined {
    const channel = this.channels.get(channelId);
    return channel?.activeScene;
  }

  /**
   * Set the active design system (theme tokens) for a channel
   */
  public setDesignSystem(channelId: string, designSystem: DesignSystem): void {
    const channel = this.getOrCreateChannel(channelId);
    channel.designSystem = designSystem;
  }

  /**
   * Get the active design system for a channel
   */
  public getDesignSystem(channelId: string): DesignSystem | undefined {
    const channel = this.channels.get(channelId);
    return channel?.designSystem;
  }

  /**
   * Clear the live design system override (e.g. when a scene is activated with
   * its own baked theme, so the explicit activation wins).
   */
  public clearDesignSystem(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (channel) channel.designSystem = undefined;
  }

  /**
   * Set the canvas orientation for a channel (landscape | portrait).
   */
  public setOrientation(channelId: string, orientation: Orientation): void {
    const channel = this.getOrCreateChannel(channelId);
    channel.orientation = orientation;
  }

  /**
   * Get the canvas orientation for a channel (defaults to 'landscape').
   */
  public getOrientation(channelId: string): Orientation {
    const channel = this.channels.get(channelId);
    return channel?.orientation ?? 'landscape';
  }

  /**
   * Get the number of subscribers in a channel
   */
  public getSubscriberCount(channelId: string): number {
    const channel = this.channels.get(channelId);
    return channel?.subscribers.size || 0;
  }

  /**
   * Last-activity timestamp (subscribe/broadcast) for a channel key, or undefined
   * if this node has seen no activity on it. Used by the Show live projection.
   */
  public getLastActivity(channelId: string): number | undefined {
    return this.lastActivity.get(channelId);
  }

  /**
   * Get all channels with active subscribers
   */
  public getActiveChannels(): string[] {
    const active: string[] = [];
    for (const [channelId, channel] of this.channels) {
      if (channel.subscribers.size > 0) {
        active.push(channelId);
      }
    }
    return active;
  }
}

// Export singleton instance
export const channelManager = new ChannelManager();
