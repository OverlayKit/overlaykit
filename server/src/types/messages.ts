import { ElementNode } from './element';
import { Scene, Orientation } from './scene';

export interface ErrorDetails {
  path?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: ErrorDetails;
  };
}

export interface SuccessResponse<T> {
  data: T;
}

// WebSocket Message Types
export interface WsSubscribeMessage {
  type: 'subscribe';
  channelId: string;
}

export interface WsUnsubscribeMessage {
  type: 'unsubscribe';
  channelId: string;
}

export interface WsPingMessage {
  type: 'ping';
}

export interface WsComponentDeployMessage {
  type: 'component_deploy';
  payload: {
    channelId: string;
    channelName: string;
    component: {
      id: string;
      name: string;
      elements: ElementNode[];
    };
    variables?: Record<string, unknown>;
    timestamp: string;
  };
}

export interface WsSceneActivateMessage {
  type: 'scene_activate';
  payload: {
    channelId: string;
    scene: Scene;
    variables?: Record<string, unknown>;
  };
}

export type ClientMessage =
  | WsSubscribeMessage
  | WsUnsubscribeMessage
  | WsPingMessage
  | WsComponentDeployMessage
  | WsSceneActivateMessage;

// Server → Client messages
export interface WsElementCreateMessage {
  type: 'element.create';
  channelId: string;
  element: ElementNode;
}

export interface WsElementUpdateMessage {
  type: 'element.update';
  channelId: string;
  id: string;
  updates: Partial<ElementNode>;
}

export interface WsElementDeleteMessage {
  type: 'element.delete';
  channelId: string;
  id: string;
}

export interface WsSceneActivatedMessage {
  type: 'scene.activated';
  channelId: string;
  scene: Scene;
  variables?: Record<string, unknown>;
  orientation?: Orientation;
}

export interface WsVariablesUpdateMessage {
  type: 'variables.update';
  channelId: string;
  variables: Record<string, unknown>;
}

export interface WsErrorMessage {
  type: 'error';
  code: string;
  message: string;
  details?: ErrorDetails;
}

export interface WsHealthMessage {
  type: 'server.health';
  status: 'ok' | 'degraded' | 'error';
  uptime: number;
  timestamp: number;
}

export interface WsPongMessage {
  type: 'pong';
}

export interface WsElementsUpdatedMessage {
  type: 'elements.updated';
  channelId: string;
  elements: ElementNode[];
  variables?: Record<string, unknown>;
  // Canvas orientation in effect for this channel, so overlays/previews can
  // size the stage (16:9 vs 9:16) without a separate round-trip.
  orientation?: Orientation;
}

export interface WsComponentDeployedMessage {
  type: 'component_deployed';
  payload: {
    channelId: string;
    componentId: string;
    elementsCount: number;
    timestamp: string;
  };
}

// One-shot sound playback pushed by a component action (sound.play) or webhook.
export interface WsSoundPlayMessage {
  type: 'sound.play';
  channelId: string;
  sound: { url: string; volume?: number; loop?: boolean };
}

// Live design-system (theme) push; null clears any live override. Previously
// broadcast with an `as never` cast — now a first-class member of the union.
export interface WsDesignSystemMessage {
  type: 'design.system';
  channelId: string;
  designSystem: { name: string; tokens: Record<string, string>; css: string } | null;
}

export type ServerMessage =
  | WsElementCreateMessage
  | WsElementUpdateMessage
  | WsElementDeleteMessage
  | WsSceneActivatedMessage
  | WsVariablesUpdateMessage
  | WsErrorMessage
  | WsHealthMessage
  | WsPongMessage
  | WsElementsUpdatedMessage
  | WsComponentDeployedMessage
  | WsSoundPlayMessage
  | WsDesignSystemMessage;
