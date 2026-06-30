/**
 * Single source of truth for interpolation lives in shared/utils/interpolate.ts
 * (nested {{user.name}} dot-path support). This thin shim re-exports it so any
 * existing client imports keep working without a divergent flat implementation.
 */
export * from '@overlaykit/renderer/utils/interpolate';
