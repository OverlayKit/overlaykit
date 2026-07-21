# @overlaykit/ui

The **Hybrid Studio OS operating-UI kit** — calm, low-glare Vue 3 chrome
components shared across `editor` and `panel`.

## The one rule

These components read **only** the `--app-*` / semantic token namespace
(`shared/styles/design-system/`). They must **never** read `--ds-*` — that is
the themeable creative-output namespace owned by `@overlaykit/renderer`. A
show theme re-skins the output; it can never re-skin the tool.

## Usage

```ts
// vite.config.ts
resolve: { alias: { '@overlaykit/ui': path.resolve(__dirname, '../shared/ui') } }
```

```vue
<script setup lang="ts">
import { Button, Badge, StatusDot, Checklist, ChecklistRow } from '@overlaykit/ui';
</script>
```

## Components (Phase 0)

`Brand` · `Button` · `IconButton` · `Badge` · `StatusDot` · `SectionLabel` ·
`Card` · `Field` · `Input` · `Select` · `SegmentedControl` · `Slider` ·
`ColorControl` · `Toggle` · `AdvancedDrawer` · `Checklist` · `ChecklistRow` ·
`Step`

Forms are `v-model`-compatible (`Input`, `Select`, `Toggle`). `Button` exposes
`iconLeft` / `iconRight` slots; `SectionLabel` a `right` slot.

## License and Attribution

Licensed under the Apache License 2.0.

Copyright 2026 [Rodrigo Vicente (@rodrigoteamx)](https://x.com/rodrigoteamx).
See the packaged `NOTICE` file for attribution information.
