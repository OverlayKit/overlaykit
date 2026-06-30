import { ElementNode } from './element';
import { Sound } from './element';

export interface SceneBackgroundMusic extends Sound {
  preload?: boolean;
}

export interface Scene {
  id: string;
  name: string;
  elements: ElementNode[];
  backgroundMusic?: SceneBackgroundMusic;
  meta?: Record<string, unknown>;
}
