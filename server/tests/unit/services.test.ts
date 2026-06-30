import { describe, it, expect, beforeEach } from 'vitest';
import { ChannelManager } from '../../src/services/ChannelManager';
import { hoistCountdownTriggers } from '../../src/utils/normalizeTriggers';

describe('hoistCountdownTriggers', () => {
  it('moves a countdown.complete trigger from the root onto the data-countdown element', () => {
    const tree = [
      {
        id: 'root', tag: 'div',
        triggers: [{ on: 'countdown.complete', actions: [{ kind: 'element.hide', target: 'root' }] }],
        children: [
          { id: 'pill', tag: 'div', children: [
            { id: 'timer', tag: 'span', attributes: { 'data-countdown': '300' } },
          ] },
        ],
      },
    ] as any;
    const out = hoistCountdownTriggers(tree);
    // original root no longer carries the trigger; the timer now does
    expect(out[0].triggers).toBeUndefined();
    const timer = out[0].children![0].children![0];
    expect(timer.triggers?.[0].on).toBe('countdown.complete');
    expect((timer.triggers?.[0].actions[0] as any).target).toBe('root');
    // input is not mutated
    expect((tree[0] as any).triggers[0].on).toBe('countdown.complete');
  });

  it('leaves a component without data-countdown untouched', () => {
    const tree = [{ id: 'a', tag: 'div', triggers: [{ on: 'click', actions: [] }] }] as any;
    const out = hoistCountdownTriggers(tree);
    expect(out[0].triggers?.[0].on).toBe('click');
  });
});

describe('ChannelManager.setVariables (deep merge)', () => {
  let cm: ChannelManager;
  const ch = 'test-channel';

  beforeEach(() => {
    cm = new ChannelManager();
  });

  it('merges scalar top-level keys without dropping others', () => {
    cm.setVariables(ch, { score: 1, name: 'A' });
    cm.setVariables(ch, { score: 2 });
    expect(cm.getVariables(ch)).toEqual({ score: 2, name: 'A' });
  });

  it('deep-merges nested objects instead of replacing them', () => {
    // The editor/panel set per-component visibility flags...
    cm.setVariables(ch, { flags: { show_lower: true, show_logo: false } });
    // ...then a live "go live" toggle pushes only flags.live.
    cm.setVariables(ch, { flags: { live: true } });
    // Regression: the one-level spread used to wipe show_lower/show_logo here.
    expect(cm.getVariables(ch)).toEqual({
      flags: { show_lower: true, show_logo: false, live: true },
    });
  });

  it('overwrites nested leaves while preserving siblings', () => {
    cm.setVariables(ch, { user: { name: 'Alex', role: 'Dev' } });
    cm.setVariables(ch, { user: { role: 'Host' } });
    expect(cm.getVariables(ch)).toEqual({ user: { name: 'Alex', role: 'Host' } });
  });

  it('treats arrays and null as leaves (replace, do not merge)', () => {
    cm.setVariables(ch, { list: [1, 2, 3], maybe: { a: 1 } });
    cm.setVariables(ch, { list: [9], maybe: null });
    expect(cm.getVariables(ch)).toEqual({ list: [9], maybe: null });
  });

  it('replaces an object with a scalar when the new value is a leaf', () => {
    cm.setVariables(ch, { x: { nested: true } });
    cm.setVariables(ch, { x: 'flat' });
    expect(cm.getVariables(ch)).toEqual({ x: 'flat' });
  });
});
