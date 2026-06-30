import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { createServer } from 'http';
import { storage } from './storage';
import { WebSocketServer } from 'ws';
import { config, validateConfig } from './config/environment';
import { setupWebSocketHandler } from './handlers/websocket';
import { logger, setLogLevel } from './utils/logger';
import elementRoutes from './routes/elements';
import variablesRoutes from './routes/variables';
import scenesRoutes from './routes/scenes';
import collectionsRoutes from './routes/collections';
import designSystemRoutes from './routes/designSystem';
import eventsRoutes from './routes/events';
import actionsRoutes from './routes/actions';
import soundsRoutes from './routes/sounds';
import healthRoutes from './routes/health';

export const app: Express = express();

if (config.trustProxy !== undefined) {
  app.set('trust proxy', config.trustProxy);
}

if (config.nodeEnv === 'production') {
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use('/api', rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMaxRequests,
    standardHeaders: true,
    legacyHeaders: false,
  }));
}

app.use(express.json({ limit: '10mb' }));
app.use(cors({ origin: config.corsOrigin, credentials: true }));

app.use((req: Request, _res: Response, next) => {
  logger.debug(req.method + ' ' + req.path, { ip: req.ip });
  next();
});

app.use('/api', elementRoutes);
app.use('/api', variablesRoutes);
app.use('/api', scenesRoutes);
app.use('/api', collectionsRoutes);
app.use('/api', designSystemRoutes);
app.use('/api', eventsRoutes);
app.use('/api', actionsRoutes);
app.use('/api', soundsRoutes);
app.use('/', healthRoutes);

app.use('/sounds', express.static(path.join(__dirname, '../public/sounds'), { maxAge: '7d', immutable: true }));

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found: ' + req.method + ' ' + req.path } });
});

app.use((error: Error, _req: Request, res: Response, _next: (error?: Error) => void) => {
  logger.error('Unhandled error', { error: error.message });
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
});

async function startServer(): Promise<void> {
  try {
    validateConfig();
    setLogLevel(config.logLevel);
    logger.info('Starting OverlayKit OSS server', { config });
    await storage.init();

    const restServer = createServer(app);
    const wsServer = createServer();
    const wss = new WebSocketServer({ server: wsServer });
    setupWebSocketHandler(wss);

    restServer.listen(config.restPort, () => {
      logger.info('REST API running on http://localhost:' + config.restPort);
      logger.info('Health check: GET http://localhost:' + config.restPort + '/health');
    });

    wsServer.listen(config.wsPort, () => {
      logger.info('WebSocket server running on ws://localhost:' + config.wsPort);
    });

    const shutdown = (signal: string) => {
      logger.info(signal + ' received, starting graceful shutdown');
      let closed = 0;
      const done = () => {
        closed += 1;
        if (closed === 2) process.exit(0);
      };
      restServer.close(done);
      wsServer.close(done);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error('Failed to start server', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}

if (process.env.VITEST !== 'true') {
  startServer();
}
