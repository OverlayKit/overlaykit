import { ElementNode } from '../types/element';

// The `countdown.complete` trigger fires from the element that owns the
// `data-countdown` attribute (see shared ElementRenderer): when its timer hits
// zero it dispatches the triggers configured ON THAT element. Streamers, though,
// naturally attach "cuando la cuenta regresiva llega a 0 → ..." to the COMPONENT
// (its root), where it silently never fires. This normalizer hoists any
// `countdown.complete` triggers found anywhere in a component's subtree onto its
// `data-countdown` element, so the trigger works wherever it was authored.

function hasCountdown(el: ElementNode): boolean {
  return !!el.attributes && el.attributes['data-countdown'] !== undefined;
}

function findCountdownEl(el: ElementNode): ElementNode | null {
  if (hasCountdown(el)) return el;
  if (Array.isArray(el.children)) {
    for (const c of el.children) {
      const found = findCountdownEl(c);
      if (found) return found;
    }
  }
  return null;
}

// Strip `countdown.complete` triggers from a subtree (except on `keep`) and collect
// them. Empty `triggers` arrays are pruned so the element shape stays clean.
function collectCountdownTriggers(el: ElementNode, keep: ElementNode, out: NonNullable<ElementNode['triggers']>): void {
  if (el !== keep && Array.isArray(el.triggers)) {
    const cc = el.triggers.filter((t) => t.on === 'countdown.complete');
    if (cc.length) {
      out.push(...cc);
      el.triggers = el.triggers.filter((t) => t.on !== 'countdown.complete');
      if (!el.triggers.length) delete el.triggers;
    }
  }
  if (Array.isArray(el.children)) {
    for (const c of el.children) collectCountdownTriggers(c, keep, out);
  }
}

/**
 * Return a deep clone of `elements` with each component's `countdown.complete`
 * triggers hoisted onto its `data-countdown` element. Never mutates the input.
 * A component with no `data-countdown` element is left untouched (the editor warns
 * about that case separately).
 */
export function hoistCountdownTriggers(elements: ElementNode[]): ElementNode[] {
  const clone: ElementNode[] = JSON.parse(JSON.stringify(elements));
  for (const root of clone) {
    const timer = findCountdownEl(root);
    if (!timer) continue;
    const collected: NonNullable<ElementNode['triggers']> = [];
    collectCountdownTriggers(root, timer, collected);
    if (collected.length) {
      timer.triggers = [...(timer.triggers || []), ...collected];
    }
  }
  return clone;
}
