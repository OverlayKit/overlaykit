# OverlayKit

OverlayKit is an MIT-licensed, self-hosted overlay studio for OBS and XSplit. It includes a protected Studio, visual editor, Preview/Program production switcher, browser-source output, and reusable protocol/renderer packages.

## What Is Included

- **Studio**: first-run owner setup, login, Shows, scene navigation, Preview/Program operation, and output security.
- **Overlay runtime**: `/production` renders a selected runtime bus; tokenized OBS URLs are fixed to Program.
- **Editor**: visual scene authoring for reusable overlay collections.
- **Panel**: transitional variable, visibility, and sound controls while typed component controls are developed.
- **Server**: local REST API plus WebSocket fan-out for one self-hosted instance.
- **Packages**: @overlaykit/protocol, @overlaykit/renderer, and @overlaykit/ui.

Managed hosting, account-based features, and hosted game experiences live outside this OSS repo.

## Quickstart

```bash
git clone https://github.com/OverlayKit/overlaykit.git
cd overlaykit
npm install
npm run dev:core
```

Open Studio and create the local owner account:

- Studio: http://localhost:5173
- API health: http://localhost:3000/health

Create a Show and save a Scene. In **Production**, load that Scene into Preview, inspect it, and press **Take** to promote the complete snapshot to Program. Runtime operations do not modify the saved Scene.

Use **Output** to rotate the read-only token and copy the complete OBS browser-source URL. OBS receives Program only; an output credential cannot subscribe to Preview or mutate production.

Preview and Program snapshots currently live in server memory. They survive WebSocket reconnects but reset when the server process restarts. Durable production recovery is intentionally not claimed yet.

## Workspaces

| Workspace | Purpose |
| --- | --- |
| protocol | Shared scene, element, variable, and WebSocket types. |
| shared | @overlaykit/renderer runtime package. |
| shared/ui | @overlaykit/ui Vue component package. |
| server | REST API and WebSocket server. |
| studio | Authenticated show workspace and product navigation. |
| client | OBS production browser-source view. |
| editor | Visual overlay editor. |
| panel | Live operator panel. |
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

## License

MIT
