import { Router, type Request, type Response } from 'express';
import type { DeviceCredentialRuntime } from '../auth/DeviceCredentialRuntime';
import type { Storage } from '../storage';
import { ProductionError, type ProductionService } from '../services/ProductionService';
import type { ProductionBus } from '../types/production';
import {
  buildDeviceActionInventory,
  type DeviceActionCatalogRuntime,
} from '../services/DeviceActionCatalogRuntime';

const DEVICE_REALM = 'overlaykit-device';
const VISIBILITY_SCOPE = 'component.visibility:write' as const;
const BODY_FIELDS = new Set(['expectedRevision', 'operationId', 'visible']);
const BEARER_CREDENTIAL = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function challenge(error?: 'invalid_request' | 'invalid_token' | 'insufficient_scope'): string {
  const parameters = [`realm="${DEVICE_REALM}"`];
  if (error) parameters.push(`error="${error}"`);
  if (error === 'insufficient_scope') parameters.push(`scope="${VISIBILITY_SCOPE}"`);
  return `Bearer ${parameters.join(', ')}`;
}

function respondInvalidRequest(res: Response, code: string, message: string): void {
  res
    .status(400)
    .set('WWW-Authenticate', challenge('invalid_request'))
    .json({ error: { code, message } });
}

function respondAuthenticationRequired(res: Response): void {
  res
    .status(401)
    .set('WWW-Authenticate', challenge('invalid_token'))
    .json({
      error: { code: 'DEVICE_AUTH_REQUIRED', message: 'A valid device credential is required' },
    });
}

function respondAuthorizationForbidden(res: Response): void {
  res
    .status(403)
    .set('WWW-Authenticate', challenge('insufficient_scope'))
    .json({
      error: {
        code: 'DEVICE_AUTH_FORBIDDEN',
        message: 'Device authority does not grant this action',
      },
    });
}

function bearerToken(req: Request, res: Response): string | null {
  if (req.headers.cookie) {
    respondInvalidRequest(
      res,
      'AMBIGUOUS_DEVICE_AUTHORITY',
      'Device requests must not include cookies'
    );
    return null;
  }
  if (Object.keys(req.query).length > 0) {
    respondInvalidRequest(
      res,
      'INVALID_DEVICE_AUTH_REQUEST',
      'Device requests must not include query parameters'
    );
    return null;
  }

  const authorizationFields = req.rawHeaders.reduce(
    (count, header, index, fields) =>
      index % 2 === 0 && header.toLowerCase() === 'authorization' && fields[index + 1] !== undefined
        ? count + 1
        : count,
    0
  );
  if (authorizationFields > 1) {
    respondInvalidRequest(
      res,
      'AMBIGUOUS_DEVICE_AUTHORITY',
      'Exactly one Authorization field is required'
    );
    return null;
  }

  const authorization = req.headers.authorization;
  const match = typeof authorization === 'string' ? BEARER_CREDENTIAL.exec(authorization) : null;
  if (authorizationFields !== 1 || !match) {
    respondAuthenticationRequired(res);
    return null;
  }
  return match[1];
}

function visibilityBody(
  req: Request,
  res: Response
): { visible: boolean; operationId: string; expectedRevision: number } | null {
  if (!isRecord(req.body)) {
    respondInvalidRequest(res, 'INVALID_VISIBILITY_REQUEST', 'A JSON object body is required');
    return null;
  }
  const keys = Object.keys(req.body);
  if (keys.length !== BODY_FIELDS.size || keys.some((key) => !BODY_FIELDS.has(key))) {
    respondInvalidRequest(
      res,
      'INVALID_VISIBILITY_REQUEST',
      'Only visible, operationId, and expectedRevision are accepted'
    );
    return null;
  }
  return {
    visible: req.body.visible as boolean,
    operationId: req.body.operationId as string,
    expectedRevision: req.body.expectedRevision as number,
  };
}

function routeTarget(value: string, res: Response): ProductionBus | null {
  if (value === 'preview' || value === 'program') return value;
  respondInvalidRequest(res, 'INVALID_PRODUCTION_TARGET', 'Target must be preview or program');
  return null;
}

function validRouteIdentifier(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && value === value.trim();
}

function deviceCredentialCode(error: unknown): string | null {
  if (!isRecord(error) || typeof error.code !== 'string') return null;
  return error.code;
}

function respondWithError(res: Response, error: unknown): void {
  const code = deviceCredentialCode(error);
  if (code === 'DEVICE_CREDENTIAL_FORBIDDEN') {
    respondAuthorizationForbidden(res);
    return;
  }
  if (code === 'INVALID_DEVICE_CREDENTIAL') {
    respondAuthenticationRequired(res);
    return;
  }
  if (error instanceof ProductionError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Device production operation failed' },
  });
}

function respondCatalogError(res: Response, error: unknown): void {
  const code = deviceCredentialCode(error);
  if (code === 'INVALID_ACTION_INVENTORY' || code === 'DUPLICATE_ACTION_CAPABILITY') {
    res.status(409).json({
      error: {
        code: 'ACTION_CATALOG_UNAVAILABLE',
        message: 'Current device actions cannot be projected',
      },
    });
    return;
  }
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Device action catalog failed' },
  });
}

export function createDeviceControlRouter(
  storage: Storage,
  production: ProductionService,
  runtime: DeviceCredentialRuntime,
  actionCatalog?: DeviceActionCatalogRuntime,
): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    next();
  });

  if (actionCatalog) {
    router.get(
      '/device/shows/:showId/actions',
      async (req: Request, res: Response) => {
        const token = bearerToken(req, res);
        if (!token) return;
        if (!validRouteIdentifier(req.params.showId, 200)) {
          respondInvalidRequest(res, 'INVALID_DEVICE_AUTH_REQUEST', 'Route identifiers are invalid');
          return;
        }

        try {
          const authority = await runtime.lifecycle.authenticate(token);
          if (!authority) {
            respondAuthenticationRequired(res);
            return;
          }
          if (authority.showId !== req.params.showId) {
            respondAuthorizationForbidden(res);
            return;
          }

          const show = await storage.getShow(req.params.showId);
          if (!show) {
            res.status(404).json({ error: { code: 'SHOW_NOT_FOUND', message: 'Show not found' } });
            return;
          }
          if (show.archivedAt !== null) {
            res.status(409).json({
              error: { code: 'SHOW_ARCHIVED', message: 'Archived Shows cannot be controlled' },
            });
            return;
          }

          const inventory = buildDeviceActionInventory(production, req.params.showId);
          const catalog = actionCatalog.projectAuthorizedControlActionCatalog(
            inventory,
            authority,
          );
          res.json({ data: catalog });
        } catch (error) {
          const code = deviceCredentialCode(error);
          if (code === 'INVALID_DEVICE_CREDENTIAL') {
            respondAuthenticationRequired(res);
            return;
          }
          respondCatalogError(res, error);
        }
      },
    );
  }

  router.post(
    '/device/shows/:showId/production/:target/components/:componentId/visibility',
    async (req: Request, res: Response) => {
      const token = bearerToken(req, res);
      if (!token) return;
      const body = visibilityBody(req, res);
      if (!body) return;
      const target = routeTarget(req.params.target, res);
      if (!target) return;
      if (
        !validRouteIdentifier(req.params.showId, 200) ||
        !validRouteIdentifier(req.params.componentId, 100)
      ) {
        respondInvalidRequest(res, 'INVALID_DEVICE_AUTH_REQUEST', 'Route identifiers are invalid');
        return;
      }

      try {
        await runtime.lifecycle.authorize(token, {
          showId: req.params.showId,
          scope: VISIBILITY_SCOPE,
          target,
          controlId: `${req.params.componentId}.visibility`,
        });

        const show = await storage.getShow(req.params.showId);
        if (!show) {
          res.status(404).json({ error: { code: 'SHOW_NOT_FOUND', message: 'Show not found' } });
          return;
        }
        if (show.archivedAt !== null) {
          res.status(409).json({
            error: { code: 'SHOW_ARCHIVED', message: 'Archived Shows cannot be controlled' },
          });
          return;
        }

        const result = production.executeVisibilityIntent(
          {
            kind: 'component.visibility',
            showId: req.params.showId,
            target,
            componentId: req.params.componentId,
            visible: body.visible,
            operationId: body.operationId,
            expectedRevision: body.expectedRevision,
          },
          { directProgram: target === 'program' }
        );

        res.json({ data: result });
      } catch (error) {
        respondWithError(res, error);
      }
    }
  );

  return router;
}
