import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChannelManager } from '../../src/services/ChannelManager';
import type { WebSocket } from 'ws';
import type { ElementNode } from '../../src/types/element';
import type { ServerMessage } from '../../src/types/messages';

// Minimal open-socket stand-in (ChannelManager only checks readyState===OPEN(1) + send).
function ws() {
  return { readyState: 1, send: vi.fn() } as unknown as WebSocket;
}
const el = (id: string, extra: Partial<ElementNode> = {}): ElementNode =>
  ({ id, tag: 'div', styles: {}, ...extra } as ElementNode);
const msg = { type: 'variables.update', channelId: 'c', variables: {} } as unknown as ServerMessage;

let cm: ChannelManager;
beforeEach(() => {
  cm = new ChannelManager();
});

describe('ChannelManager — subscriptions & broadcast', () => {
  it('tracks subscriber count and broadcasts to open sockets', () => {
    const a = ws();
    const b = ws();
    cm.subscribe('c', a);
    cm.subscribe('c', b);
    expect(cm.getSubscriberCount('c')).toBe(2);
    cm.broadcast('c', msg);
    expect((a.send as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect((b.send as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
  });

  it('does not send to a non-open socket', () => {
    const closed = { readyState: 3, send: vi.fn() } as unknown as WebSocket;
    cm.subscribe('c', closed);
    cm.broadcast('c', msg);
    expect((closed.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('cleans up an empty channel after the last unsubscribe', () => {
    const a = ws();
    cm.subscribe('c', a);
    cm.unsubscribe('c', a);
    expect(cm.getSubscriberCount('c')).toBe(0);
  });

  it('broadcast to an unknown channel is a no-op', () => {
    expect(() => cm.broadcast('ghost', msg)).not.toThrow();
  });
});

describe('ChannelManager — variables (deep merge)', () => {
  it('deep-merges nested objects, preserving sibling keys', () => {
    cm.setVariables('c', { flags: { show_hero: true }, user: { name: 'Ana' } });
    cm.setVariables('c', { flags: { live: true } }); // must NOT clobber show_hero
    expect(cm.getVariables('c')).toEqual({
      flags: { show_hero: true, live: true },
      user: { name: 'Ana' },
    });
  });

  it('scalars and arrays overwrite (leaves)', () => {
    cm.setVariables('c', { n: 1, list: [1, 2] });
    cm.setVariables('c', { n: 2, list: [3] });
    expect(cm.getVariables('c')).toEqual({ n: 2, list: [3] });
  });

  it('replaceVariables wipes the whole bag', () => {
    cm.setVariables('c', { a: 1, b: 2 });
    cm.replaceVariables('c', { c: 3 });
    expect(cm.getVariables('c')).toEqual({ c: 3 });
  });
});

describe('ChannelManager — elements & state', () => {
  it('adds, updates, deletes and clears elements', () => {
    cm.addElement('c', el('a'));
    cm.addElement('c', el('b'));
    expect(cm.getElements('c').map((e) => e.id)).toEqual(['a', 'b']);
    const updated = cm.updateElement('c', 'a', { content: 'hi' });
    expect(updated?.content).toBe('hi');
    expect(cm.deleteElement('c', 'b')).toBe(true);
    expect(cm.getElements('c').map((e) => e.id)).toEqual(['a']);
    cm.clearElements('c');
    expect(cm.getElements('c')).toEqual([]);
  });

  it('updateElement returns null for a missing element/channel', () => {
    expect(cm.updateElement('c', 'nope', {})).toBeNull();
  });

  it('defaults orientation to landscape and accepts an override', () => {
    expect(cm.getOrientation('c')).toBe('landscape');
    cm.setOrientation('c', 'portrait');
    expect(cm.getOrientation('c')).toBe('portrait');
  });
});

describe('ChannelManager — lastActivity (Show live projection)', () => {
  it('stamps activity on subscribe and on broadcast', () => {
    expect(cm.getLastActivity('c')).toBeUndefined();
    cm.subscribe('c', ws());
    const afterSub = cm.getLastActivity('c');
    expect(afterSub).toBeGreaterThan(0);
    cm.broadcast('c', msg);
    expect(cm.getLastActivity('c')).toBeGreaterThanOrEqual(afterSub!);
  });
});
