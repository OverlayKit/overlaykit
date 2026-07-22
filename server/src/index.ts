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
import {
  DEVICE_TRANSPORT_CLOSE_TIMEOUT_MS,
  DeviceWebSocketGateway,
} from './handlers/DeviceWebSocketGateway';
import { WebSocketUpgradeRouter } from './handlers/WebSocketUpgradeRouter';
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
import { DeviceConnectionAuthorityCoordinator } from './services/DeviceConnectionAuthorityCoordinator';
import { DeviceConnectionAuthorityMonitor } from './services/DeviceConnectionAuthorityMonitor';

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
  deviceAuthorityCoordinator: DeviceConnectionAuthorityCoordinator;
  deviceAuthorityMonitor: DeviceConnectionAuthorityMonitor;
  deviceGateway: DeviceWebSocketGateway;
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
  const ownsDeviceCredentials = dependencies.deviceCredentials === undefined;
  const deviceCredentials = dependencies.deviceCredentials
    ?? await (dependencies.createDeviceCredentials ?? createDeviceCredentialRuntime)();
  let deviceActionCatalog: DeviceActionCatalogRuntime;
  try {
    deviceActionCatalog = dependencies.deviceActionCatalog
      ?? await (dependencies.createDeviceActionCatalog ?? createDeviceActionCatalogRuntime)();
  } catch (error) {
    if (ownsDeviceCredentials) await deviceCredentials.close().catch(() => undefined);
    throw error;
  }
  const deviceAuthorityCoordinator = new DeviceConnectionAuthorityCoordinator();
  const deviceAuthorityMonitor = new DeviceConnectionAuthorityMonitor({
    source: deviceCredentials.authoritySource,
    onBackgroundError: (error) => logger.error('Device authority monitor failed', {
      error: error instanceof Error ? error.message : String(error),
    }),
  });
  const deviceGateway = new DeviceWebSocketGateway({
    credentials: deviceCredentials.lifecycle,
    coordinator: deviceAuthorityCoordinator,
    authorityMonitor: deviceAuthorityMonitor,
  });

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
    deviceAuthorityCoordinator,
    deviceAuthorityMonitor,
    deviceGateway,
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
    const wss = new WebSocketServer({ noServer: true });
    setupWebSocketHandler(wss, runtime.auth, config.corsOrigin);
    const upgradeRouter = new WebSocketUpgradeRouter(wss, runtime.deviceGateway);
    wsServer.on('upgrade', (request, socket, head) => {
      upgradeRouter.handleUpgrade(request, socket, head);
    });

    restServer.listen(config.restPort, config.host, () => {
      logger.info('REST API running on http://' + config.host + ':' + config.restPort);
      logger.info('Health check: GET http://' + config.host + ':' + config.restPort + '/health');
    });

    wsServer.listen(config.wsPort, config.wsHost, () => {
      logger.info('Browser WebSocket running on ws://' + config.wsHost + ':' + config.wsPort + '/ws');
      logger.info('Device WebSocket running on ws://' + config.wsHost + ':' + config.wsPort + '/device');
    });

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(signal + ' received, starting graceful shutdown');
      upgradeRouter.stop();
      const closeServer = (server: ReturnType<typeof createServer>) => new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      for (const client of wss.clients) client.close(1001, 'Server shutdown');
      const closingServers = Promise.all([closeServer(restServer), closeServer(wsServer)]);
      const forceClose = setTimeout(() => {
        logger.warn('Shutdown deadline reached; forcing remaining transports closed');
        for (const client of wss.clients) client.terminate();
        runtime.deviceGateway.terminate();
        restServer.closeAllConnections();
        wsServer.closeAllConnections();
      }, DEVICE_TRANSPORT_CLOSE_TIMEOUT_MS);
      forceClose.unref();
      try {
        await runtime.deviceGateway.shutdown();
        await runtime.deviceCredentials.close();
        await closingServers;
        clearTimeout(forceClose);
        process.exit(0);
      } catch (error) {
        clearTimeout(forceClose);
        logger.error('Graceful shutdown failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        runtime.deviceGateway.terminate();
        process.exit(1);
      }
    };
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.on('SIGINT', () => { void shutdown('SIGINT'); });
  } catch (error) {
    logger.error('Failed to start server', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}

if (process.env.VITEST !== 'true') {
  startServer();
}
