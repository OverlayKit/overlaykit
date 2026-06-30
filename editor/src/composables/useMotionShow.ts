// Animated show/hide for a Componente-mode node.
//
// Binding = an attribute `data-motion-show` whose value is a variable path
// `flags.show_<sanitizedNodeId>`. The shared renderer hides the layer (adds
// `.dsm-out`) only when the value is one of: 'false','0','no','off'
// (empty/undefined/'true'/'1' ⇒ visible). The flag defaults to `true`, lives in
// the scene's variables object, and is therefore toggleable live from the panel
// or an action. This mirrors LayoutComposer's `toggleLayerEye`.

import type { ElementNode } from '@overlaykit/renderer/types/element';

/** The variable path a node's visibility flag lives at (e.g. flags.show_hero_1). */
export function motionShowVar(id: string): string {
  return `flags.show_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

const isObj = (v: any): v is Record<string, any> => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * Bind a node's visibility to its show flag: writes
 * `data-motion-show="flags.show_<id>"` on the node and seeds
 * `variables.flags.show_<id> = true` (visible) when unset, so the flag ships
 * with the scene and is toggleable live.
 */
export function bindMotionShow(node: ElementNode, variables: Record<string, any>): void {
  if (!node.attributes) node.attributes = {};
  node.attributes['data-motion-show'] = motionShowVar(node.id);
  if (!isObj(variables.flags)) variables.flags = {};
  const key = `show_${node.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  if (variables.flags[key] === undefined) variables.flags[key] = true;
}

/** Remove the visibility binding (and prune an empty attributes object). */
export function unbindMotionShow(node: ElementNode): void {
  if (!node.attributes) return;
  delete node.attributes['data-motion-show'];
  if (Object.keys(node.attributes).length === 0) delete node.attributes;
}

/** Whether a node currently carries a `data-motion-show` binding. */
export function isBoundToShow(node: ElementNode): boolean {
  return node.attributes?.['data-motion-show'] !== undefined;
}
