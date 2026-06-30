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

// Component events & actions (Feature B). Mirror of shared/types/element.ts.
export type ComponentTriggerType = 'countdown.complete' | 'click' | 'mounted';

export type ComponentActionKind =
  | 'scene.activate'
  | 'element.show'
  | 'element.hide'
  | 'element.update'
  | 'element.delete'
  | 'variables.update'
  | 'sound.play';

export interface ComponentAction {
  kind: ComponentActionKind;
  target?: string;
  channelId?: string;
  updates?: Partial<ElementNode>;
  variables?: Record<string, unknown>;
  sound?: Sound;
}

export interface ComponentTrigger {
  on: ComponentTriggerType;
  actions: ComponentAction[];
}

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
}
