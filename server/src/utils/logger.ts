export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLogLevel: LogLevel = 'debug';

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLogLevel];
}

function formatLog(level: string, message: string, data?: unknown): string {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${dataStr}`;
}

export const logger = {
  debug: (message: string, data?: unknown) => {
    if (shouldLog('debug')) {
      console.log(formatLog('debug', message, data));
    }
  },
  info: (message: string, data?: unknown) => {
    if (shouldLog('info')) {
      console.log(formatLog('info', message, data));
    }
  },
  warn: (message: string, data?: unknown) => {
    if (shouldLog('warn')) {
      console.warn(formatLog('warn', message, data));
    }
  },
  error: (message: string, data?: unknown) => {
    if (shouldLog('error')) {
      console.error(formatLog('error', message, data));
    }
  },
};
