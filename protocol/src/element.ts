/**
 * Shared Element Types for OverlayKit
 * Used by both dashboard and client
 */

export interface Styles {
  [key: string]: string;
}

export interface Keyframe {
  offset: number;
  styles: Styles;
}

export interface Animation {
  name: string;
  duration: number;
  easing?: string;
  keyframes: Keyframe[];
}

export interface Sound {
  url: string;
  volume?: number;
  loop?: boolean;
}

export interface ElementEvent {
  type: string;
  handler?: string;
  sound?: Sound;
}

export interface AutoRemove {
  delay: number;
  exitAnimation?: Animation;
}

/**
 * Component events & actions (Feature B). A component can declare triggers; when a
 * trigger fires (locally on the overlay, or remotely via a webhook), its actions
 * are dispatched server-authoritatively so every subscriber stays in sync.
 */
export type ComponentTriggerType = 'countdown.complete' | 'click' | 'mounted';

export type ComponentActionKind =
  | 'scene.activate' // activate a saved collection by id (target = collectionId)
  | 'element.show' // target = element id
  | 'element.hide' // target = element id
  | 'element.update' // target = element id, updates = Partial<ElementNode>
  | 'element.delete' // target = element id
  | 'variables.update' // variables = Variables (merged into the channel)
  | 'sound.play'; // sound = Sound

export interface ComponentAction {
  kind: ComponentActionKind;
  target?: string; // element id / collection id
  channelId?: string; // optional channel override (defaults to the source channel)
  updates?: Partial<ElementNode>; // for element.update
  variables?: Variables; // for variables.update
  sound?: Sound; // for sound.play
}

export interface ComponentTrigger {
  on: ComponentTriggerType;
  actions: ComponentAction[];
}

/**
 * Unified Element Node structure
 * Used by both dashboard and client - no conversion needed
 */
export interface ElementNode {
  id: string;
  tag: string;
  content?: string | null;
  styles: Styles;
  attributes?: Record<string, string>;
  children?: ElementNode[];
  animations?: Animation[];
  events?: ElementEvent[];
  triggers?: ComponentTrigger[];
  autoRemove?: AutoRemove;

  // Dashboard-specific properties (optional)
  position?: { x: number; y: number };
  size?: { width: number; height: number };

  // Simple/transitional animation + auto-hide fields (dashboard format)
  animationIn?: string;
  animationDuration?: number;
  autoRemoveDelay?: number;
}

/**
 * A variable value: a scalar, or a nested object for dot-path interpolation
 * (e.g. {{user.firstName}}). First-level variable names must match the name
 * pattern; nested keys are free-form data paths.
 */
export type VariableValue = string | number | boolean | { [key: string]: VariableValue };

export interface Variables {
  [key: string]: VariableValue;
}

/**
 * Scene definition - compatible with server scene structure
 */
export interface SceneBackgroundMusic extends Sound {
  preload?: boolean;
}

/** OBS canvas orientation. landscape = 16:9, portrait = 9:16 (mobile / Shorts). */
export type Orientation = 'landscape' | 'portrait';

export interface Scene {
  id: string;
  name: string;
  elements: ElementNode[];
  variables?: Variables;
  backgroundMusic?: SceneBackgroundMusic;
  /** Canvas orientation; treated as 'landscape' when absent (back-compat). */
  orientation?: Orientation;
  meta?: Record<string, unknown>;
}