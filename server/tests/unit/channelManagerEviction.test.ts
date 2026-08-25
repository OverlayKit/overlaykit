import type { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { ChannelManager } from '../../src/services/ChannelManager';

/**
 * CHG-0072 hardening: the ChannelManager lastActivity map must be bounded (LRU) so a long-lived
 * process that has seen many distinct channels cannot leak memory, while still surviving a channel
 * going empty so the live projection keeps recent activity.
 */
const ws = {} as WebSocket;

describe('ChannelManager lastActivity bound', () => {
  it('preserves last activity after a channel goes empty', () => {
    const cm = new ChannelManager();
    cm.subscribe('show-1', ws);
    cm.unsubscribe('show-1', ws); // the channel is removed, but its activity survives
    expect(typeof cm.getLastActivity('show-1')).toBe('number');
  });

  it('evicts the least-recently-active channel when over the cap', () => {
    const cm = new ChannelManager({ maxLastActivityEntries: 3 });
    cm.subscribe('c0', ws);
    cm.subscribe('c1', ws);
    cm.subscribe('c2', ws);
    // Re-touch c0 so it becomes most-recent — eviction must be LRU, not FIFO.
    cm.subscribe('c0', ws);
    // A fourth distinct channel exceeds the cap and evicts the oldest, which is now c1.
    cm.subscribe('c3', ws);
    expect(cm.getLastActivity('c1')).toBeUndefined();
    expect(typeof cm.getLastActivity('c0')).toBe('number');
    expect(typeof cm.getLastActivity('c2')).toBe('number');
    expect(typeof cm.getLastActivity('c3')).toBe('number');
  });

  it('stays bounded across many distinct channels', () => {
    const cm = new ChannelManager({ maxLastActivityEntries: 5 });
    for (let i = 0; i < 100; i += 1) cm.subscribe(`chan-${i}`, ws);
    let present = 0;
    for (let i = 0; i < 100; i += 1) {
      if (cm.getLastActivity(`chan-${i}`) !== undefined) present += 1;
    }
    expect(present).toBe(5);
    expect(typeof cm.getLastActivity('chan-99')).toBe('number');
    expect(cm.getLastActivity('chan-0')).toBeUndefined();
  });
});
