# OverlayKit

OverlayKit is an Apache-2.0-licensed, self-hosted overlay studio for OBS and XSplit. It includes a protected Studio, visual editor, Preview/Program production switcher, browser-source output, and reusable protocol/renderer packages.

## What Is Included

- **Studio**: first-run owner setup, login, Shows, scene navigation, declared Preview controls, Preview/Program operation, and output security.
- **Overlay runtime**: `/production` renders a selected runtime bus; tokenized OBS URLs are fixed to Program.
- **Editor**: visual scene authoring with component-owned, typed operator controls.
- **Panel**: focused Preview operator surface generated only from declared component controls.
- **Server**: local REST API plus WebSocket fan-out for one self-hosted instance.
- **Packages**: @overlaykit/protocol, @overlaykit/renderer, and @overlaykit/ui.

Managed hosting, account-based features, and hosted game experiences live outside this OSS repo.

## Quickstart

Node.js 24 or newer is required.

```bash
git clone https://github.com/OverlayKit/overlaykit.git
cd overlaykit
npm install
npm run dev:core
```

Open Studio and create the local owner account:

- Studio: http://localhost:5173
- API health: http://localhost:3000/health
- Browser/OBS WebSocket: ws://localhost:8080/ws
- Hardware WebSocket: ws://localhost:8080/device (requires an Owner-issued device bearer)

Create a Show and save a Scene. In **Production**, load that Scene into Preview, inspect it, and press **Take** to promote the complete snapshot to Program. Runtime operations do not modify the saved Scene.

Components may declare text, number, toggle, selection, and color controls in Editor. Production renders only that declared catalog. Applying a control creates a new Preview revision; Program remains unchanged until **Take**.

Use **Output** to rotate the read-only token and copy the complete OBS browser-source URL. OBS receives Program only; an output credential cannot subscribe to Preview or mutate production.

Preview and Program snapshots currently live in server memory. They survive WebSocket reconnects but reset when the server process restarts. Durable production recovery is intentionally not claimed yet.

## Workspaces

| Workspace | Purpose |
| --- | --- |
| protocol | Shared scene, element, production, control, variable, and WebSocket types. |
| shared | @overlaykit/renderer runtime package. |
| shared/ui | @overlaykit/ui Vue component package. |
| server | REST API and WebSocket server. |
| studio | Authenticated show workspace and product navigation. |
| client | OBS production browser-source view. |
| editor | Visual overlay editor. |
| panel | Declared-control Preview operator panel. |
| landing | Public OSS landing page. |

## Development

```bash
npm run dev          # server + Studio + overlay + editor + panel + landing
npm run dev:core     # server + Studio + overlay + editor + panel
npm run check        # lint + type-check + tests
npm run build        # build all workspaces
```

## Development Governance

OverlayKit compiles immutable decisions, an active profile, and concrete enforcement mechanisms
into a deterministic governance plan. Every change carries typed claims, success criteria, and
definition-of-done evidence.

Start with [GOVERNANCE.md](GOVERNANCE.md), then run:

```bash
npm run governance:verify
```

## License and Attribution

OverlayKit is licensed under the [Apache License 2.0](LICENSE).

Copyright 2026 [Rodrigo Vicente (@rodrigoteamx)](https://x.com/rodrigoteamx).
See [NOTICE](NOTICE) for attribution information.
