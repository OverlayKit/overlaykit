// Motion System — theme-independent motion patterns.
//
// These rules read the motion tokens that a design system sets
// (--ds-dur-* / --ds-ease-* / --ds-stagger) WITH fallbacks, so:
//   - a theme that defines no motion tokens still animates with sane defaults, and
//   - saved scenes whose baked `ds-theme` predates motion tokens are unaffected.
//
// The stylesheet is theme-independent: only the token *values* change per theme.
// Inject it once per document (overlay + editor preview); the design-system tokens
// arrive through the existing :root{--ds-*} path.

export const MOTION_PATTERNS_CSS = `
/* Scene-intro stagger: the renderer stamps --dsm-i (0,1,2…) on each top-level
   component, so each entrance is delayed by stagger * index. */
.dsm-enter { animation-delay: calc(var(--ds-stagger, 0ms) * var(--dsm-i, 0)); }

/* Emphasis pop (live events) and idle pulse — token-driven, adopted from Phase 4. */
.dsm-pop   { animation: dsm-pop var(--ds-dur-base, 300ms) var(--ds-ease-emphasis, cubic-bezier(.34,1.56,.64,1)) both; }
.dsm-pulse { animation: dsm-pulse 2.4s var(--ds-ease-exit, ease-in-out) infinite; }
@keyframes dsm-pop   { from { transform: scale(.9); } to { transform: scale(1); } }
@keyframes dsm-pulse { 0%, 100% { opacity: .7; } 50% { opacity: 1; } }

/* Variable-driven visibility: data-motion-show="<var>" fades + slides the element out
   (themed via --ds-ease-exit / --ds-dur-base) when the bound variable is falsy, and back
   in when truthy — toggled live from the panel or an action. Applied to a layer wrapper
   (no baked entrance), so a CSS transition animates BOTH directions cleanly. */
.dsm-toggle {
  transition: opacity var(--ds-dur-base, 300ms) var(--ds-ease-exit, cubic-bezier(.4,0,1,1)),
              transform var(--ds-dur-base, 300ms) var(--ds-ease-exit, cubic-bezier(.4,0,1,1));
}
/* The !important wins even when the bound element carries its own baked entrance
   animation: per the CSS cascade, important author declarations override animation
   fill (which would otherwise pin opacity to 1), while the declared transition —
   highest priority of all — still animates the change in both directions. This makes
   data-motion-show robust whether it sits on a bare layer wrapper or directly on an
   animated component (the editor Visibilidad control binds the node itself). */
.dsm-toggle.dsm-out {
  opacity: 0 !important;
  transform: translateY(-10px) scale(.98) !important;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  * { --ds-dur-fast: 1ms; --ds-dur-base: 1ms; --ds-dur-slow: 1ms; --ds-stagger: 0ms; }
  .dsm-pulse { animation: none; }
}

/* Kill switch: a flags.motion=false channel variable sets data-motion="off" on the
   scene container, neutralizing motion the same way reduced-motion does. */
[data-motion="off"], [data-motion="off"] * {
  --ds-dur-fast: 1ms; --ds-dur-base: 1ms; --ds-dur-slow: 1ms; --ds-stagger: 0ms;
}
[data-motion="off"] .dsm-pulse { animation: none; }
`;

const STYLE_ID = 'dom-motion-patterns';

/** Inject the motion-patterns stylesheet into the document head, once (idempotent). */
export function injectMotionPatterns(doc: Document = document): void {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement('style');
  el.id = STYLE_ID;
  el.textContent = MOTION_PATTERNS_CSS;
  doc.head.appendChild(el);
}
