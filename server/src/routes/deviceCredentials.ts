import { Router, type Request, type Response } from 'express';
import type { DeviceCredentialRuntime } from '../auth/DeviceCredentialRuntime';
import type { Storage } from '../storage';

const DEVICE_ERROR_STATUS: Readonly<Record<string, number>> = {
  OWNER_REQUIRED: 403,
  INVALID_DEVICE_CREDENTIAL: 400,
  DEVICE_CREDENTIAL_NOT_FOUND: 404,
  DEVICE_CREDENTIAL_REVOKED: 409,
  DEVICE_CREDENTIAL_EXPIRED: 409,
  DEVICE_CREDENTIAL_CONFLICT: 409,
  DEVICE_CREDENTIAL_COLLISION: 409,
  DEVICE_CREDENTIAL_FORBIDDEN: 403,
};

function ownerFrom(req: Request): { principalId: string; roles: string[] } {
  const user = req.authSession!.user;
  return { principalId: user.id, roles: [...user.roles] };
}

function noStore(res: Response): void {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Pragma', 'no-cache');
}

function sendDeviceError(res: Response, error: unknown): void {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  const status = DEVICE_ERROR_STATUS[code];
  if (status) {
    res.status(status).json({
      error: {
        code,
        message: typeof candidate.message === 'string'
          ? candidate.message
          : 'Device credential operation failed',
      },
    });
    return;
  }
  res.status(500).json({
    error: {
      code: 'DEVICE_CREDENTIAL_INTERNAL_ERROR',
      message: 'Device credential operation failed',
    },
  });
}

async function requireActiveShow(
  storage: Storage,
  showId: string,
  res: Response,
): Promise<boolean> {
  const show = await storage.getShow(showId);
  if (!show) {
    res.status(404).json({ error: { code: 'SHOW_NOT_FOUND', message: 'Show not found' } });
    return false;
  }
  if (show.archivedAt !== null) {
    res.status(409).json({ error: { code: 'SHOW_ARCHIVED', message: 'Show is archived' } });
    return false;
  }
  return true;
}

async function credentialBelongsToShow(
  runtime: DeviceCredentialRuntime,
  credentialId: string,
  showId: string,
  res: Response,
): Promise<boolean> {
  const record = await runtime.store.get(credentialId);
  if (!record || record.showId !== showId) {
    res.status(404).json({
      error: {
        code: 'DEVICE_CREDENTIAL_NOT_FOUND',
        message: 'Device credential was not found',
      },
    });
    return false;
  }
  return true;
}

export function createDeviceCredentialsRouter(
  storage: Storage,
  runtime: DeviceCredentialRuntime,
): Router {
  const router = Router();

  router.post('/shows/:showId/integrations/device-credentials', async (req, res) => {
    try {
      if (!(await requireActiveShow(storage, req.params.showId, res))) return;
      const issued = await runtime.lifecycle.issue(ownerFrom(req), {
        label: req.body?.label,
        showId: req.params.showId,
        targets: req.body?.targets,
        controlIds: req.body?.controlIds,
        scopes: req.body?.scopes,
        expiresAt: req.body?.expiresAt,
      });
      noStore(res);
      res.status(201).json({ data: issued });
    } catch (error) {
      sendDeviceError(res, error);
    }
  });

  router.post(
    '/shows/:showId/integrations/device-credentials/:credentialId/rotate',
    async (req, res) => {
      try {
        if (!(await requireActiveShow(storage, req.params.showId, res))) return;
        if (!(await credentialBelongsToShow(
          runtime,
          req.params.credentialId,
          req.params.showId,
          res,
        ))) return;
        const issued = await runtime.lifecycle.rotate(ownerFrom(req), req.params.credentialId);
        noStore(res);
        res.status(201).json({ data: issued });
      } catch (error) {
        sendDeviceError(res, error);
      }
    },
  );

  router.delete(
    '/shows/:showId/integrations/device-credentials/:credentialId',
    async (req, res) => {
      try {
        if (!(await requireActiveShow(storage, req.params.showId, res))) return;
        if (!(await credentialBelongsToShow(
          runtime,
          req.params.credentialId,
          req.params.showId,
          res,
        ))) return;
        const credential = await runtime.lifecycle.revoke(ownerFrom(req), req.params.credentialId);
        noStore(res);
        res.json({ data: { credential } });
      } catch (error) {
        sendDeviceError(res, error);
      }
    },
  );

  return router;
}
