import { ElementNode } from './element';
import { Sound } from './element';

export interface SceneBackgroundMusic extends Sound {
  preload?: boolean;
}

/** OBS canvas orientation. landscape = 16:9, portrait = 9:16 (mobile / Shorts). */
export type Orientation = 'landscape' | 'portrait';

export interface Scene {
  id: string;
  name: string;
  elements: ElementNode[];
  backgroundMusic?: SceneBackgroundMusic;
  /** Canvas orientation; treated as 'landscape' when absent (back-compat). */
  orientation?: Orientation;
  meta?: Record<string, unknown>;
}
