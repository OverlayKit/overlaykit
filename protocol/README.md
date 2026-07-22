# @overlaykit/protocol

Shared OverlayKit contracts and deterministic state projections for scenes,
Preview/Program production, authorized action discovery, control feedback,
catalog-bound device control frames, strict device bootstrap acknowledgements,
server-known visibility projection, and device credentials.

## Install

```bash
npm install @overlaykit/protocol
```

The package publishes compiled ESM and TypeScript declarations. ESM consumers
can import the root or an explicit public subpath:

```ts
import { DeviceCredentialLifecycle } from '@overlaykit/protocol/device-credential';
```

CommonJS applications must use native dynamic import:

```js
const protocol = await import('@overlaykit/protocol/device-credential');
```

Synchronous `require()` is not part of the package contract.

## Public Subpaths

- `@overlaykit/protocol`
- `@overlaykit/protocol/element`
- `@overlaykit/protocol/scene`
- `@overlaykit/protocol/messages`
- `@overlaykit/protocol/production`
- `@overlaykit/protocol/control-action-catalog`
- `@overlaykit/protocol/control-feedback`
- `@overlaykit/protocol/control-feedback-authority`
- `@overlaykit/protocol/control-visibility-feedback`
- `@overlaykit/protocol/device-control-frame`
- `@overlaykit/protocol/device-bootstrap`
- `@overlaykit/protocol/device-state-sync`
- `@overlaykit/protocol/device-credential`

## License and Attribution

Licensed under the Apache License 2.0.

Copyright 2026 [Rodrigo Vicente (@rodrigoteamx)](https://x.com/rodrigoteamx).
See the packaged `NOTICE` file for attribution information.
