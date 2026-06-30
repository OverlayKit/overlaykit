/**
 * Client Element Types - exports from shared for consistency
 * This ensures both client and dashboard use the same element structure
 */

// Re-export shared types
export {
  type Styles,
  type Keyframe,
  type Animation,
  type Sound,
  type ElementEvent,
  type AutoRemove,
  type ElementNode,
  type ComponentAction,
  type ComponentTrigger,
  type ComponentActionKind,
  type ComponentTriggerType,
  type Variables,
  type Scene,
  type SceneBackgroundMusic
} from '@overlaykit/renderer/types/element';
