import dotenv from 'dotenv';

dotenv.config();

export interface ServerConfig {
  host: string;
  wsHost: string;
  restPort: number;
  wsPort: number;
  nodeEnv: 'development' | 'production';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  corsOrigin: string[];
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  authRateLimitWindowMs: number;
  authRateLimitMaxRequests: number;
  sessionTtlMs: number;
  cookieSecure: 'auto' | 'always' | 'never';
  trustProxy?: number | boolean;
  sslCertPath?: string;
  sslKeyPath?: string;
}

function parseEnv(key: string, defaultValue?: string): string | undefined {
  return process.env[key] || defaultValue;
}

function parsePort(port: string | undefined, defaultPort: number): number {
  if (!port) return defaultPort;
  const parsed = parseInt(port, 10);
  return Number.isNaN(parsed) ? defaultPort : parsed;
}

function parseTrustProxy(raw: string | undefined): number | boolean | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

function parseCookieSecure(raw: string | undefined): 'auto' | 'always' | 'never' {
  if (raw === 'always' || raw === 'never') return raw;
  return 'auto';
}

function parseCorsOrigin(corsEnv: string | undefined): string[] {
  if (!corsEnv) {
    return [
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:5180',
      'http://localhost:5181',
      'http://localhost:5183'
    ];
  }
  return corsEnv.split(',').map((origin) => origin.trim()).filter(Boolean);
}

export const config: ServerConfig = {
  host: parseEnv('HOST', '127.0.0.1') || '127.0.0.1',
  wsHost: parseEnv('WS_HOST', parseEnv('HOST', '127.0.0.1')) || '127.0.0.1',
  restPort: parsePort(parseEnv('REST_PORT'), 3000),
  wsPort: parsePort(parseEnv('WS_PORT'), 8080),
  nodeEnv: (parseEnv('NODE_ENV', 'development') as 'development' | 'production') || 'development',
  logLevel: (parseEnv('LOG_LEVEL', 'debug') as 'debug' | 'info' | 'warn' | 'error') || 'debug',
  corsOrigin: parseCorsOrigin(parseEnv('CORS_ORIGIN')),
  rateLimitWindowMs: parseInt(parseEnv('RATE_LIMIT_WINDOW_MS', '60000') || '60000', 10),
  rateLimitMaxRequests: parseInt(parseEnv('RATE_LIMIT_MAX_REQUESTS', '100') || '100', 10),
  authRateLimitWindowMs: parseInt(parseEnv('AUTH_RATE_LIMIT_WINDOW_MS', '900000') || '900000', 10),
  authRateLimitMaxRequests: parseInt(parseEnv('AUTH_RATE_LIMIT_MAX_REQUESTS', '10') || '10', 10),
  sessionTtlMs: parseInt(parseEnv('SESSION_TTL_MS', '43200000') || '43200000', 10),
  cookieSecure: parseCookieSecure(parseEnv('COOKIE_SECURE', 'auto')),
  trustProxy: parseTrustProxy(parseEnv('TRUST_PROXY')),
  sslCertPath: parseEnv('SSL_CERT_PATH'),
  sslKeyPath: parseEnv('SSL_KEY_PATH'),
};

export function validateConfig(): void {
  if (!config.host.trim()) throw new Error('HOST must not be empty');
  if (!config.wsHost.trim()) throw new Error('WS_HOST must not be empty');
  if (config.restPort < 1 || config.restPort > 65535) throw new Error('Invalid REST_PORT: ' + config.restPort);
  if (config.wsPort < 1 || config.wsPort > 65535) throw new Error('Invalid WS_PORT: ' + config.wsPort);
  if (config.corsOrigin.length === 0) throw new Error('CORS_ORIGIN must not be empty');
  if (config.sessionTtlMs < 60000) throw new Error('SESSION_TTL_MS must be at least 60000');
}
