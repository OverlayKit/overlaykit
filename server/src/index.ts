import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { createServer } from 'http';
import { storage, type Storage } from './storage';
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
import {
  authService,
  createDeviceCredentialRuntime,
  enforceBrowserOrigin,
  requireRole,
  requireSession,
  type AuthService,
  type DeviceCredentialRuntime,
} from './auth';
import { createAuthRouter } from './routes/auth';
import { createDeviceCredentialsRouter } from './routes/deviceCredentials';
import { createDeviceControlRouter } from './routes/deviceControl';
import { createShowsRouter } from './routes/shows';
import { createProductionRouter } from './routes/production';
import { productionService, type ProductionService } from './services/ProductionService';
import {
  createDeviceActionCatalogRuntime,
  type DeviceActionCatalogRuntime,
} from './services/DeviceActionCatalogRuntime';

export interface AppDependencies {
  auth?: AuthService;
  dataStorage?: Storage;
  production?: ProductionService;
  deviceCredentials?: DeviceCredentialRuntime;
  deviceActionCatalog?: DeviceActionCatalogRuntime;
}

export interface ServerRuntimeDependencies extends AppDependencies {
  createDeviceCredentials?: () => Promise<DeviceCredentialRuntime>;
  createDeviceActionCatalog?: () => Promise<DeviceActionCatalogRuntime>;
}

export interface ServerRuntime {
  app: Express;
  auth: AuthService;
  dataStorage: Storage;
  production: ProductionService;
  deviceCredentials: DeviceCredentialRuntime;
  deviceActionCatalog: DeviceActionCatalogRuntime;
}

export function createApp(dependencies: AppDependencies = {}): Express {
  const app = express();
  const auth = dependencies.auth ?? authService;
  const dataStorage = dependencies.dataStorage ?? storage;
  const production = dependencies.production ?? productionService;
  const deviceCredentials = dependencies.deviceCredentials;
  const deviceActionCatalog = dependencies.deviceActionCatalog;

  if (config.trustProxy !== undefined) app.set('trust proxy', config.trustProxy);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use('/api', rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMaxRequests,
    standardHeaders: true,
    legacyHeaders: false,
  }));

  app.use(express.json({ limit: '10mb' }));
  app.use(cors({ origin: config.corsOrigin, credentials: true }));

  app.use((req: Request, _res: Response, next) => {
    logger.debug(req.method + ' ' + req.path, { ip: req.ip });
    next();
  });

  app.use('/', healthRoutes);
  app.use('/sounds', express.static(path.join(__dirname, '../public/sounds'), { maxAge: '7d', immutable: true }));
  if (deviceCredentials) {
    app.use(
      '/api',
      createDeviceControlRouter(
        dataStorage,
        production,
        deviceCredentials,
        deviceActionCatalog,
      ),
    );
  }
  app.use('/api', enforceBrowserOrigin(config.corsOrigin));
  app.use('/api/auth/setup', rateLimit({
    windowMs: config.authRateLimitWindowMs,
    max: config.authRateLimitMaxRequests,
    standardHeaders: true,
    legacyHeaders: false,
  }));
  app.use('/api/auth/login', rateLimit({
    windowMs: config.authRateLimitWindowMs,
    max: config.authRateLimitMaxRequests,
    standardHeaders: true,
    legacyHeaders: false,
  }));
  app.use('/api', createAuthRouter(auth, config.cookieSecure));
  app.use('/api', requireSession(auth));
  if (deviceCredentials) {
    app.use(
      '/api',
      requireRole('owner'),
      createDeviceCredentialsRouter(dataStorage, deviceCredentials),
    );
  }
  app.use('/api', requireRole('producer'), createShowsRouter(dataStorage));
  app.use('/api', requireRole('producer'), createProductionRouter(dataStorage, production));

  app.use('/api', elementRoutes);
  app.use('/api', variablesRoutes);
  app.use('/api', scenesRoutes);
  app.use('/api', collectionsRoutes);
  app.use('/api', designSystemRoutes);
  app.use('/api', eventsRoutes);
  app.use('/api', actionsRoutes);
  app.use('/api', soundsRoutes);

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found: ' + req.method + ' ' + req.path } });
  });

  app.use((error: Error, _req: Request, res: Response, _next: (error?: Error) => void) => {
    logger.error('Unhandled error', { error: error.message });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  return app;
}

export const app: Express = createApp();

export async function createServerRuntime(
  dependencies: ServerRuntimeDependencies = {},
): Promise<ServerRuntime> {
  const auth = dependencies.auth ?? authService;
  const dataStorage = dependencies.dataStorage ?? storage;
  const production = dependencies.production ?? productionService;

  await dataStorage.init();
  await auth.init();
  const deviceCredentials = dependencies.deviceCredentials
    ?? await (dependencies.createDeviceCredentials ?? createDeviceCredentialRuntime)();
  const deviceActionCatalog = dependencies.deviceActionCatalog
    ?? await (dependencies.createDeviceActionCatalog ?? createDeviceActionCatalogRuntime)();

  return {
    app: createApp({
      auth,
      dataStorage,
      production,
      deviceCredentials,
      deviceActionCatalog,
    }),
    auth,
    dataStorage,
    production,
    deviceCredentials,
    deviceActionCatalog,
  };
}

async function startServer(): Promise<void> {
  try {
    validateConfig();
    setLogLevel(config.logLevel);
    logger.info('Starting OverlayKit OSS server', { config });
    const runtime = await createServerRuntime();

    const restServer = createServer(runtime.app);
    const wsServer = createServer();
    const wss = new WebSocketServer({ server: wsServer });
    setupWebSocketHandler(wss, runtime.auth, config.corsOrigin);

    restServer.listen(config.restPort, config.host, () => {
      logger.info('REST API running on http://' + config.host + ':' + config.restPort);
      logger.info('Health check: GET http://' + config.host + ':' + config.restPort + '/health');
    });

    wsServer.listen(config.wsPort, config.wsHost, () => {
      logger.info('WebSocket server running on ws://' + config.wsHost + ':' + config.wsPort);
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
