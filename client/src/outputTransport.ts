export const OUTPUT_CREDENTIAL_FRAGMENT_KEY = 'output';

export interface BrowserLocation {
  hash: string;
  host: string;
  protocol: string;
}

export function outputTokenFromFragment(hash: string): string | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  return new URLSearchParams(fragment).get(OUTPUT_CREDENTIAL_FRAGMENT_KEY);
}

export function resolveWebSocketEndpoint(
  explicitUrl: string | undefined,
  location: Pick<BrowserLocation, 'host' | 'protocol'>
): string {
  if (explicitUrl) return explicitUrl;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
}

export function outputAuthenticationMessage(token: string): {
  type: 'authenticate.output';
  token: string;
} {
  return { type: 'authenticate.output', token };
}
