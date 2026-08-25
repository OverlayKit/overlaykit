import { describe, expect, it } from 'vitest';
import {
  MAX_ELEMENT_DEPTH,
  MAX_ELEMENT_NODES,
  validateElementNode,
  validateSceneNode,
} from '../../src/validation/validator';

/**
 * CHG-0071 hardening: a deeply-nested or huge ElementNode tree must be rejected by a bounded,
 * iterative pre-check before it reaches the recursive Ajv validator, so it cannot overflow the
 * call stack (a DoS on POST /api/elements, /api/scenes, and the WS component_deploy/scene_activate
 * paths).
 */
function leaf(): Record<string, unknown> {
  return { id: 'leaf', tag: 'div', styles: {} };
}

function deepElement(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = leaf();
  for (let i = 0; i < depth; i += 1) {
    node = { id: `n${i}`, tag: 'div', styles: {}, children: [node] };
  }
  return node;
}

describe('Element tree nesting bound', () => {
  it('accepts a valid shallow element', () => {
    expect(
      validateElementNode({ id: 'a', tag: 'div', styles: {}, children: [leaf()] }),
    ).toBeNull();
  });

  it('rejects an element nested past the depth limit', () => {
    const error = validateElementNode(deepElement(MAX_ELEMENT_DEPTH + 5));
    expect(error?.details.reason).toContain(`${MAX_ELEMENT_DEPTH} levels`);
  });

  it('rejects a very deep tree without overflowing the stack', () => {
    // The old recursive Ajv validator would RangeError here; the iterative guard short-circuits at
    // the depth limit instead.
    let error: ReturnType<typeof validateElementNode> = null;
    expect(() => {
      error = validateElementNode(deepElement(100_000));
    }).not.toThrow();
    expect(error).not.toBeNull();
  });

  it('rejects a tree exceeding the node-count limit', () => {
    const children = Array.from({ length: MAX_ELEMENT_NODES + 1 }, () => leaf());
    const error = validateElementNode({ id: 'root', tag: 'div', styles: {}, children });
    expect(error?.details.reason).toContain(`${MAX_ELEMENT_NODES} nodes`);
  });

  it('rejects a scene whose elements nest past the depth limit', () => {
    const scene = { id: 's', name: 'S', elements: [deepElement(MAX_ELEMENT_DEPTH + 5)] };
    const error = validateSceneNode(scene);
    expect(error?.details.reason).toContain('levels');
  });
});
