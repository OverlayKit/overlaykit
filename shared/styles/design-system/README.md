# OverlayKit Design System (vendored)

**Direction: "Hybrid Studio OS."** A calm, precise live-production *operating UI*
paired with an expressive, themeable *creative-output* layer. The tools stay
quiet; the outputs can be loud.

> **Core principle — Power without exposure.** The primary interface never forces
> non-technical users to think in technical terms. JSON, WebSocket, CSS
> variables, `channelId`, `ElementNode` and cubic-béziers are hidden and
> translated into human controls: sliders, pickers, toggles, previews, drawers.

These files are the canonical OverlayKit design-token source for this package.
Treat token values as read-only unless you are intentionally changing the public
design system.

## Two token namespaces — never mix them

| Namespace | Layer | Who sees it | Themed? |
|---|---|---|---|
| `--app-*` + semantic aliases (`--text-*`, `--surface-*`, `--state-*`, `--button-*`…) | **Operating UI** (editor, panel, dashboard, landing, play) | streamer / host / producer | **Never** |
| `--ds-*` | **Creative output** (the on-stream overlay) | the OBS audience | **Re-skinned per show** |

App chrome components must **never** read `--ds-*`. A show theme must **never**
touch `--app-*`. The overlay output components (`shared/components/ElementRenderer`
and the scene payload) read only `--ds-*`; `output-theme.css` ships the default
"Broadcast" theme, and the editor (`editor/src/design/tokens.ts`) emits the same
`--ds-*` contract when a show theme is activated.

## Files

- **`styles.css`** — the single entry consumers link. A manifest of `@import`s only.
- **`tokens/`** — `fonts.css` (Inter webfont), `colors.css` (primitives + `--app-*`
  surfaces), `typography.css`, `spacing.css` (4px base, radii, depth), `motion.css`
  (durations/easings + reduced-motion + `[data-motion="off"]` kill switch),
  `semantic.css` (intent aliases + state colors + brand gradient), `output-theme.css`
  (the default `--ds-*` theme).
- **`app-base.css`** — *opt-in* operating-UI baseline (body type/surface, focus
  rings, section-label + tabular-numeral helpers, quiet scrollbars). Not part of
  the token manifest. Overlays do **not** import this.

## How to consume

```ts
// app entry (main.ts)
import '@overlaykit/renderer/styles/design-system/styles.css'; // tokens + Inter
import '@overlaykit/renderer/styles/design-system/app-base.css'; // operating-UI baseline (optional)
```

…or, where a relative path is simpler, `import '../../shared/styles/design-system/styles.css'`.

`shared/styles/tokens.css` is a **back-compat bridge**: it `@import`s `styles.css`
and aliases the few legacy names still referenced in code (`--brand`, `--brand-2`,
`--danger`, `--success`, `--app-surface`). New code should prefer the design-system
names directly.

## Visual rules (the short version)

- **One accent at a time:** cyan `--app-accent` (#22d3ee) for selection / focus /
  active. Brand purple→cyan `--grad-brand` for the **one** primary action and the
  ◆ brand mark only — never gradient-over-everything.
- **Surfaces:** void `--app-bg` → `--app-panel` → `--app-bar` → raised `--app-raised`
  → hover `--app-hover`; hairlines `--app-line`. Cards = raised fill + 1px hairline +
  `--shadow-md`. Active/selected = 2px cyan border + `--app-selected-bg`.
- **Inputs:** inset `--surface-inset` well, 1px hairline, `--radius-sm`, cyan focus
  ring, no glow.
- **Type:** Inter everywhere in chrome; tabular numerals on timers/scores/counts;
  uppercase 12px cyan micro-labels head rail sections. Display fonts are reserved
  for `--ds-*` output themes.
- **Motion:** calm and fast in chrome (120–320ms, no bounce); expressive but
  governed on the broadcast output. `prefers-reduced-motion` and `[data-motion="off"]`
  collapse durations to ~1ms.
- **State is sacred and never color-alone:** live red, draft amber, published/
  connected green, destructive red — always paired with a dot, label, or icon.
- **Voice:** human labels, not protocol labels (Show not `channelId`, Layers not
  `elements`, Visible on stream not `data-motion-show`). Spanish is first-class.
