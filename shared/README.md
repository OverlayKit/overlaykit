# @overlaykit/renderer

The canonical OverlayKit renderer: the single source of truth for turning a
`Scene` / `ElementNode` payload into live DOM, shared by the production overlay,
the editor preview, and the dashboard so authoring and broadcast render
identically.

It is a **source-distributed Vue package** — consume it from a Vue-aware bundler
(Vite, etc.) with `vue` as a peer dependency.

## What's inside

| Export | Purpose |
| --- | --- |
| `@overlaykit/renderer/components/ElementRenderer.vue` | Recursive renderer: interpolation, animations, auto-remove, event sounds |
| `@overlaykit/renderer/services/AnimationRunner` | Builds/injects CSS `@keyframes` from a structured `Animation` |
| `@overlaykit/renderer/services/SoundManager` | Singleton audio playback (event sounds + background music) |
| `@overlaykit/renderer/utils/interpolate` | `{{var}}` / nested `{{user.name}}` interpolation |
| `@overlaykit/renderer/types/element` | `ElementNode`, `Animation`, `Scene`, `Variables`, … |

## Usage

```ts
import ElementRenderer from '@overlaykit/renderer/components/ElementRenderer.vue';
import type { ElementNode, Variables } from '@overlaykit/renderer/types/element';
```

```vue
<ElementRenderer :element="element" :variables="variables" />
```

The same component renders the editor preview and the OBS overlay, so what an
author builds is what goes live. Sounds attempt to autoplay (allowed in OBS
browser sources; they degrade gracefully in a normal tab until a user gesture).

## Payload shape (`ElementNode`)

`id`, `tag`, `styles` are required. Optional: `content`, `attributes`,
`children`, `animations[]` (`{ name, duration(ms), easing?, keyframes[] }`),
`events[]` (`{ type, handler?, sound? }`), `autoRemove` (`{ delay(ms),
exitAnimation? }`), plus the dashboard/transitional fields `position`, `size`,
`animationIn`, `animationDuration`, `autoRemoveDelay`.
