import { logger } from '../../utils/logger';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

export type MessageHandler = (message: WsMessage) => void;

export class WebSocketAdapter {
  private ws: WebSocket | null = null;
  private url: string;
  private state: ConnectionState = 'disconnected';
  private messageHandlers: Set<MessageHandler> = new Set();
  private errorHandlers: Set<(error: Error) => void> = new Set();
  private stateChangeHandlers: Set<(state: ConnectionState) => void> = new Set();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private baseBackoffMs = 2000;
  private maxBackoffMs = 60000;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private subscribedChannels: Set<string> = new Set();

  constructor(url: string) {
    this.url = url;
  }

  /**
   * Connect to the WebSocket server
   */
  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.state === 'connected' || this.state === 'connecting') {
        resolve();
        return;
      }

      this.setState('connecting');

      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          logger.info('WebSocket connected', { url: this.url });
          this.setState('connected');
          this.reconnectAttempts = 0;
          this.startHeartbeat();
          // Restore subscriptions after a (re)connect. Empty on first connect;
          // on reconnect this re-subscribes the overlay so it keeps receiving updates.
          this.resubscribeAll();
          resolve();
        };

        this.ws.onmessage = (event: MessageEvent) => {
          try {
            const message: WsMessage = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (error) {
            logger.error('Failed to parse WebSocket message', {
              error: String(error),
              data: event.data,
            });
          }
        };

        this.ws.onerror = (error: Event) => {
          logger.error('WebSocket error', { error: String(error) });
          this.setState('error');
          this.notifyError(new Error('WebSocket connection error'));
          reject(new Error('WebSocket connection error'));
        };

        this.ws.onclose = () => {
          logger.info('WebSocket closed');
          this.setState('disconnected');
          this.stopHeartbeat();
          this.attemptReconnect();
        };
      } catch (error) {
        logger.error('Failed to create WebSocket', { error: String(error) });
        this.setState('error');
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the WebSocket server
   */
  public disconnect(): void {
    logger.info('Disconnecting WebSocket');
    this.stopHeartbeat();
    this.clearReconnectTimeout();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState('disconnected');
  }

  /**
   * Send a message to the server
   */
  public send(message: WsMessage): void {
    if (this.state !== 'connected' || !this.ws) {
      logger.warn('Cannot send message, WebSocket not connected', { state: this.state });
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
      this.trackSubscription(message);
    } catch (error) {
      logger.error('Failed to send WebSocket message', { error: String(error) });
    }
  }

  /**
   * Subscribe to messages
   */
  public onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to errors
   */
  public onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => {
      this.errorHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to state changes
   */
  public onStateChange(handler: (state: ConnectionState) => void): () => void {
    this.stateChangeHandlers.add(handler);
    return () => {
      this.stateChangeHandlers.delete(handler);
    };
  }

  /**
   * Get current connection state
   */
  public getState(): ConnectionState {
    return this.state;
  }

  /**
   * Check if connected
   */
  public isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Resubscribe to a channel (for reconnection)
   */
  public resubscribe(channelId: string): void {
    this.send({ type: 'subscribe', channelId });
  }

  // Private methods

  /**
   * Re-send subscribe for every channel we were subscribed to (after a reconnect).
   */
  private resubscribeAll(): void {
    if (this.subscribedChannels.size === 0 || !this.ws) return;
    for (const channelId of this.subscribedChannels) {
      logger.info('Re-subscribing to channel after reconnect', { channelId });
      this.ws.send(JSON.stringify({ type: 'subscribe', channelId }));
    }
  }

  /**
   * Track subscribe/unsubscribe so subscriptions can be restored on reconnect.
   */
  private trackSubscription(message: WsMessage): void {
    const channelId = typeof message.channelId === 'string' ? message.channelId : undefined;
    if (!channelId) return;
    if (message.type === 'subscribe') {
      this.subscribedChannels.add(channelId);
    } else if (message.type === 'unsubscribe') {
      this.subscribedChannels.delete(channelId);
    }
  }

  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      logger.debug('WebSocket state changed', { from: this.state, to: newState });
      this.state = newState;
      this.notifyStateChange();
    }
  }

  private handleMessage(message: WsMessage): void {
    logger.debug('WebSocket message received', { type: message.type });
    this.messageHandlers.forEach((handler) => {
      try {
        handler(message);
      } catch (error) {
        logger.error('Error in message handler', { error: String(error) });
      }
    });
  }

  private notifyError(error: Error): void {
    this.errorHandlers.forEach((handler) => {
      try {
        handler(error);
      } catch (err) {
        logger.error('Error in error handler', { error: String(err) });
      }
    });
  }

  private notifyStateChange(): void {
    this.stateChangeHandlers.forEach((handler) => {
      try {
        handler(this.state);
      } catch (error) {
        logger.error('Error in state change handler', { error: String(error) });
      }
    });
  }

  private startHeartbeat(): void {
    this.heartbeatTimeout = setInterval(() => {
      if (this.isConnected()) {
        this.send({ type: 'ping' });
      }
    }, 30000) as unknown as ReturnType<typeof setTimeout>; // 30s heartbeat (per spec)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimeout) {
      clearInterval(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached');
      this.setState('error');
      return;
    }

    this.reconnectAttempts++;
    const backoffMs = Math.min(this.baseBackoffMs * Math.pow(2, this.reconnectAttempts - 1), this.maxBackoffMs);

    logger.info('Attempting to reconnect', {
      attempt: this.reconnectAttempts,
      backoffMs,
    });

    this.setState('reconnecting');
    this.reconnectTimeout = setTimeout(() => {
      this.connect().catch((error) => {
        logger.error('Reconnection failed', { error: String(error) });
      });
    }, backoffMs) as unknown as ReturnType<typeof setTimeout>;
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }
}
