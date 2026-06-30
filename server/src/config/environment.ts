import dotenv from 'dotenv';

dotenv.config();

export interface ServerConfig {
  restPort: number;
  wsPort: number;
  nodeEnv: 'development' | 'production';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  corsOrigin: string[];
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
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

function parseCorsOrigin(corsEnv: string | undefined): string[] {
  if (!corsEnv) {
    return [
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:5180',
      'http://localhost:5181'
    ];
  }
  return corsEnv.split(',').map((origin) => origin.trim()).filter(Boolean);
}

export const config: ServerConfig = {
  restPort: parsePort(parseEnv('REST_PORT'), 3000),
  wsPort: parsePort(parseEnv('WS_PORT'), 8080),
  nodeEnv: (parseEnv('NODE_ENV', 'development') as 'development' | 'production') || 'development',
  logLevel: (parseEnv('LOG_LEVEL', 'debug') as 'debug' | 'info' | 'warn' | 'error') || 'debug',
  corsOrigin: parseCorsOrigin(parseEnv('CORS_ORIGIN')),
  rateLimitWindowMs: parseInt(parseEnv('RATE_LIMIT_WINDOW_MS', '60000') || '60000', 10),
  rateLimitMaxRequests: parseInt(parseEnv('RATE_LIMIT_MAX_REQUESTS', '100') || '100', 10),
  trustProxy: parseTrustProxy(parseEnv('TRUST_PROXY')),
  sslCertPath: parseEnv('SSL_CERT_PATH'),
  sslKeyPath: parseEnv('SSL_KEY_PATH'),
};

export function validateConfig(): void {
  if (config.restPort < 1 || config.restPort > 65535) throw new Error('Invalid REST_PORT: ' + config.restPort);
  if (config.wsPort < 1 || config.wsPort > 65535) throw new Error('Invalid WS_PORT: ' + config.wsPort);
  if (config.corsOrigin.length === 0) throw new Error('CORS_ORIGIN must not be empty');
}
