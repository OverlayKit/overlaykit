import { createHash, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

/**
 * Minimal obs-websocket protocol 5 (RPC version 1) client for governed proofs.
 *
 * The client identifies with `eventSubscriptions: 0`, so OBS sends no event traffic; it only
 * correlates Request (op 6) with RequestResponse (op 7) by requestId. It never logs or retains the
 * password beyond the Identify handshake.
 */

export interface ObsHello {
  obsWebSocketVersion: string;
  rpcVersion: number;
  authentication?: { challenge: string; salt: string };
}

export interface ObsRequestStatus {
  result: boolean;
  code: number;
  comment?: string;
}

export interface ObsClientOptions {
  url: string;
  password?: string;
  rpcVersion?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export class ObsUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: 'connect' | 'timeout' | 'authentication' | 'protocol'
  ) {
    super(message);
    this.name = 'ObsUnavailableError';
  }
}

export class ObsRequestError extends Error {
  constructor(
    readonly requestType: string,
    readonly status: ObsRequestStatus
  ) {
    super(`${requestType} failed with obs-websocket code ${status.code}: ${status.comment ?? ''}`);
    this.name = 'ObsRequestError';
  }
}

export function obsAuthenticationString(password: string, salt: string, challenge: string): string {
  const secret = createHash('sha256').update(`${password}${salt}`).digest('base64');
  return createHash('sha256').update(`${secret}${challenge}`).digest('base64');
}

interface Pending {
  requestType: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Envelope {
  op: number;
  d: Record<string, unknown>;
}

export class ObsWebSocketClient {
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  private constructor(
    private readonly socket: WebSocket,
    readonly hello: ObsHello,
    readonly negotiatedRpcVersion: number,
    private readonly requestTimeoutMs: number
  ) {
    socket.on('message', (data) => this.onMessage(data.toString()));
    socket.on('close', () => this.failPending(new Error('obs-websocket connection closed')));
  }

  static connect(options: ObsClientOptions): Promise<ObsWebSocketClient> {
    const rpcVersion = options.rpcVersion ?? 1;
    const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(options.url);
      const timer = setTimeout(() => {
        finish(new ObsUnavailableError('obs-websocket handshake timed out', 'timeout'));
        socket.terminate();
      }, connectTimeoutMs);
      const finish = (error: Error | null, client?: ObsWebSocketClient): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(client!);
      };
      socket.once('error', (error) =>
        finish(new ObsUnavailableError(`obs-websocket unreachable: ${error.message}`, 'connect'))
      );
      socket.once('close', (code, reason) => {
        const text = reason.toString();
        const kind = code === 4009 || code === 4008 ? 'authentication' : 'protocol';
        finish(new ObsUnavailableError(`obs-websocket closed ${code} ${text}`.trim(), kind));
      });
      let hello: ObsHello | undefined;
      const onHandshake = (raw: Buffer | ArrayBuffer | Buffer[]): void => {
        let envelope: Envelope;
        try {
          envelope = JSON.parse(raw.toString()) as Envelope;
        } catch {
          finish(new ObsUnavailableError('obs-websocket sent non-JSON', 'protocol'));
          socket.terminate();
          return;
        }
        if (envelope.op === 0) {
          hello = envelope.d as unknown as ObsHello;
          const identify: Record<string, unknown> = { rpcVersion, eventSubscriptions: 0 };
          if (hello.authentication) {
            if (!options.password) {
              finish(
                new ObsUnavailableError('obs-websocket requires a password', 'authentication')
              );
              socket.close(1000);
              return;
            }
            identify.authentication = obsAuthenticationString(
              options.password,
              hello.authentication.salt,
              hello.authentication.challenge
            );
          }
          socket.send(JSON.stringify({ op: 1, d: identify }));
          return;
        }
        if (envelope.op === 2 && hello) {
          socket.off('message', onHandshake);
          const negotiated = Number(envelope.d.negotiatedRpcVersion ?? rpcVersion);
          finish(null, new ObsWebSocketClient(socket, hello, negotiated, requestTimeoutMs));
        }
      };
      socket.on('message', onHandshake);
    });
  }

  request<T extends Record<string, unknown> = Record<string, unknown>>(
    requestType: string,
    requestData: Record<string, unknown> = {}
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('obs-websocket client is closed'));
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${requestType} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, {
        requestType,
        resolve: resolve as (value: Record<string, unknown>) => void,
        reject,
        timer,
      });
      this.socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return new Promise((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.close(1000);
    });
  }

  private onMessage(raw: string): void {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }
    if (envelope.op !== 7) return;
    const requestId = String(envelope.d.requestId ?? '');
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    const status = envelope.d.requestStatus as ObsRequestStatus | undefined;
    if (!status || status.result !== true) {
      pending.reject(
        new ObsRequestError(pending.requestType, status ?? { result: false, code: 0 })
      );
      return;
    }
    pending.resolve((envelope.d.responseData as Record<string, unknown> | undefined) ?? {});
  }

  private failPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }
}
