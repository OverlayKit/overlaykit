import { WebSocket, Server as WSServer } from 'ws';
import { IncomingMessage } from 'http';
import { channelManager } from '../services/ChannelManager';
import { channelKey, DEFAULT_TENANT_ID } from '../tenancy';
import { logger } from '../utils/logger';
import { ClientMessage, ServerMessage } from '../types/messages';
import type { AuthService } from '../auth/AuthService';
import { parseCookies, SESSION_COOKIE } from '../auth/http';
import type { WebSocketAccess } from '../auth/types';

function routeKey(channelId: string): string {
  return channelKey(DEFAULT_TENANT_ID, channelId);
}

export function setupWebSocketHandler(
  wss: WSServer,
  auth: AuthService,
  allowedOrigins: string[] = [],
): void {
  const originAllowlist = new Set(allowedOrigins);
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const clientIp = req.socket.remoteAddress || 'unknown';
    const origin = req.headers.origin;
    if (origin && !originAllowlist.has(origin)) {
      ws.close(1008, 'Origin not allowed');
      return;
    }

    const access = authenticateConnection(req, auth);
    if (!access) {
      ws.close(1008, 'Authentication required');
      return;
    }

    logger.debug('WebSocket client connected', { clientIp, access: access.kind });

    const subscribedChannels = new Set<string>();

    ws.on('message', (data: Buffer) => {
      try {
        const message: unknown = JSON.parse(data.toString());
        handleClientMessage(ws, message as ClientMessage, subscribedChannels, access);
      } catch (error) {
        logger.warn('Failed to parse WebSocket message', { error: String(error) });
        sendErrorMessage(ws, 'PARSE_ERROR', 'Invalid JSON message');
      }
    });

    ws.on('close', () => {
      logger.debug('WebSocket client disconnected', { clientIp });
      for (const channelId of subscribedChannels) {
        channelManager.unsubscribe(routeKey(channelId), ws);
      }
      subscribedChannels.clear();
    });

    ws.on('error', (error: Error) => {
      logger.error('WebSocket error', { error: error.message });
    });
  });
}

function authenticateConnection(req: IncomingMessage, auth: AuthService): WebSocketAccess | null {
  const url = new URL(req.url || '/', 'http://localhost');
  const outputToken = url.searchParams.get('token');
  if (auth.verifyOutputToken(outputToken)) return { kind: 'output', user: null };

  const sessionToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const session = auth.authenticateSession(sessionToken);
  return session ? { kind: 'studio', user: session.user } : null;
}

function handleClientMessage(
  ws: WebSocket,
  message: ClientMessage,
  subscribedChannels: Set<string>,
  access: WebSocketAccess,
): void {
  if (!message || typeof message !== 'object' || !('type' in message)) {
    sendErrorMessage(ws, 'INVALID_MESSAGE', 'Message must have a type field');
    return;
  }

  switch (message.type) {
    case 'subscribe':
      handleSubscribe(ws, message, subscribedChannels);
      break;
    case 'unsubscribe':
      handleUnsubscribe(ws, message, subscribedChannels);
      break;
    case 'component_deploy':
      if (access.kind === 'output') {
        sendErrorMessage(ws, 'FORBIDDEN', 'Output connections are read-only');
        break;
      }
      handleComponentDeploy(ws, message);
      break;
    case 'scene_activate':
      if (access.kind === 'output') {
        sendErrorMessage(ws, 'FORBIDDEN', 'Output connections are read-only');
        break;
      }
      handleSceneActivate(ws, message);
      break;
    case 'ping':
      handlePing(ws);
      break;
    default:
      sendErrorMessage(ws, 'UNKNOWN_MESSAGE_TYPE', 'Unknown message type: ' + ((message as { type?: string }).type || 'undefined'));
  }
}

function handleSubscribe(ws: WebSocket, message: ClientMessage, subscribedChannels: Set<string>): void {
  if (message.type !== 'subscribe') return;
  const { channelId } = message;

  if (!channelId || typeof channelId !== 'string' || channelId.length === 0) {
    sendErrorMessage(ws, 'INVALID_CHANNEL_ID', 'channelId must be a non-empty string');
    return;
  }
  if (channelId.length > 100) {
    sendErrorMessage(ws, 'INVALID_CHANNEL_ID', 'channelId must be 100 characters or less');
    return;
  }
  if (subscribedChannels.has(channelId)) {
    sendErrorMessage(ws, 'ALREADY_SUBSCRIBED', 'Already subscribed to channel: ' + channelId);
    return;
  }

  const key = routeKey(channelId);
  channelManager.subscribe(key, ws);
  subscribedChannels.add(channelId);
  logger.debug('Client subscribed to channel', { channelId });

  ws.send(JSON.stringify({
    type: 'subscription.confirmed',
    channelId,
    state: {
      elements: channelManager.getElements(key),
      variables: channelManager.getVariables(key),
      designSystem: channelManager.getDesignSystem(key),
      orientation: channelManager.getOrientation(key),
    },
  }));
}

function handleUnsubscribe(ws: WebSocket, message: ClientMessage, subscribedChannels: Set<string>): void {
  if (message.type !== 'unsubscribe') return;
  const { channelId } = message;

  if (!channelId || typeof channelId !== 'string') {
    sendErrorMessage(ws, 'INVALID_CHANNEL_ID', 'channelId must be a non-empty string');
    return;
  }
  if (!subscribedChannels.has(channelId)) {
    sendErrorMessage(ws, 'NOT_SUBSCRIBED', 'Not subscribed to channel: ' + channelId);
    return;
  }

  channelManager.unsubscribe(routeKey(channelId), ws);
  subscribedChannels.delete(channelId);
  logger.debug('Client unsubscribed from channel', { channelId });
}

function handleComponentDeploy(ws: WebSocket, message: ClientMessage): void {
  try {
    if (message.type !== 'component_deploy') return;
    const { payload } = message;
    if (!payload || !payload.channelId || !payload.component) {
      sendErrorMessage(ws, 'INVALID_PAYLOAD', 'Component deploy requires channelId and component');
      return;
    }

    const { channelId, channelName, component, variables } = payload;
    const key = routeKey(channelId);
    logger.info('Component deployed to channel', {
      channelId,
      channelName,
      componentId: component.id,
      elementsCount: component.elements?.length || 0,
      variablesCount: variables ? Object.keys(variables).length : 0,
    });

    if (variables && typeof variables === 'object') channelManager.setVariables(key, variables);
    if (component.elements && Array.isArray(component.elements)) {
      channelManager.clearElements(key);
      for (const element of component.elements) channelManager.addElement(key, element);
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'component_deployed',
        payload: {
          channelId,
          componentId: component.id,
          elementsCount: component.elements?.length || 0,
          variablesCount: variables ? Object.keys(variables).length : 0,
          timestamp: new Date().toISOString(),
        },
      }));
    }

    broadcastToChannel(key, {
      type: 'elements.updated',
      channelId,
      elements: channelManager.getElements(key),
      variables: channelManager.getVariables(key),
      orientation: channelManager.getOrientation(key),
    });
  } catch (error) {
    logger.error('Error handling component deploy', { error: String(error) });
    sendErrorMessage(ws, 'DEPLOY_ERROR', 'Failed to deploy component');
  }
}

function handleSceneActivate(ws: WebSocket, message: ClientMessage): void {
  try {
    if (message.type !== 'scene_activate') return;
    const { payload } = message;
    if (!payload || !payload.channelId || !payload.scene) {
      sendErrorMessage(ws, 'INVALID_PAYLOAD', 'Scene activate requires channelId and scene');
      return;
    }

    const { channelId, scene, variables } = payload;
    const key = routeKey(channelId);
    logger.info('Scene activated in channel', {
      channelId,
      sceneId: scene.id,
      sceneName: scene.name,
      elementsCount: scene.elements?.length || 0,
      variablesCount: variables ? Object.keys(variables).length : 0,
    });

    if (variables && typeof variables === 'object') channelManager.setVariables(key, variables);
    channelManager.clearElements(key);
    if (scene.elements && Array.isArray(scene.elements)) {
      for (const element of scene.elements) channelManager.addElement(key, element);
    }
    channelManager.setOrientation(key, scene.orientation ?? 'landscape');

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'scene.activated',
        channelId,
        scene,
        variables: channelManager.getVariables(key),
        orientation: channelManager.getOrientation(key),
      }));
    }

    broadcastToChannel(key, {
      type: 'elements.updated',
      channelId,
      elements: channelManager.getElements(key),
      variables: channelManager.getVariables(key),
      orientation: channelManager.getOrientation(key),
    });
  } catch (error) {
    logger.error('Error handling scene activate', { error: String(error) });
    sendErrorMessage(ws, 'SCENE_ACTIVATE_ERROR', 'Failed to activate scene');
  }
}

function handlePing(ws: WebSocket): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
}

export function sendErrorMessage(ws: WebSocket, code: string, message: string, details?: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'error', code, message, details }));
  }
}

export function broadcastToChannel(channelId: string, message: ServerMessage): void {
  channelManager.broadcast(channelId, message);
}
