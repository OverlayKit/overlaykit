import { describe, expect, it } from 'vitest';
import {
  outputAuthenticationMessage,
  outputTokenFromFragment,
  resolveWebSocketEndpoint,
} from '../../src/outputTransport';

describe('output transport', () => {
  it('reads the Output credential only from the client-side fragment', () => {
    expect(outputTokenFromFragment('#output=ok_output_secret')).toBe('ok_output_secret');
    expect(outputTokenFromFragment('output=encoded+value')).toBe('encoded value');
    expect(outputTokenFromFragment('#unrelated=value')).toBeNull();
  });

  it('derives a same-origin WebSocket endpoint with the page security level', () => {
    expect(
      resolveWebSocketEndpoint(undefined, {
        protocol: 'https:',
        host: 'output.example.test',
      })
    ).toBe('wss://output.example.test/ws');
    expect(
      resolveWebSocketEndpoint(undefined, {
        protocol: 'http:',
        host: '127.0.0.1:5183',
      })
    ).toBe('ws://127.0.0.1:5183/ws');
    expect(
      resolveWebSocketEndpoint('wss://split.example.test/browser', {
        protocol: 'https:',
        host: 'output.example.test',
      })
    ).toBe('wss://split.example.test/browser');
  });

  it('builds the bounded authentication frame separately from the endpoint', () => {
    expect(outputAuthenticationMessage('ok_output_secret')).toEqual({
      type: 'authenticate.output',
      token: 'ok_output_secret',
    });
  });
});
