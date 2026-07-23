import { createHash } from 'crypto';
import type { DeviceCredentialAuthority } from '@overlaykit/protocol/device-credential' with {
  'resolution-mode': 'import',
};
import type {
  DeviceCommandExecute,
  DeviceCommandRefusalReason,
  DeviceCommandResponseMessage,
  DeviceCommandResponsePayload,
} from '@overlaykit/protocol/device-command' with { 'resolution-mode': 'import' };
import type {
  ComponentVisibilityIntent,
  ComponentVisibilityResult,
  ProductionCommandOutcome,
} from '../types/production';
import {
  ProductionError,
  type ProductionService,
} from './ProductionService';
import type { DeviceBootstrapSession } from './DeviceBootstrapSessionRuntime';
import type { DeviceBootstrapSigningAuthority } from './DeviceBootstrapSnapshotIssuer';
import { DeviceConnectionAuthorityError } from './DeviceConnectionAuthorityCoordinator';
import { productionVisibilityIntentHash } from './SqliteProductionStateStore';

type DeviceCommandProtocolModule = typeof import('@overlaykit/protocol/device-command', {
  with: { 'resolution-mode': 'import' },
});

export const DEVICE_COMMAND_SEND_TIMEOUT_MS = 3_000;

export const DEVICE_COMMAND_CLOSE_REASONS = [
  'command.protocol_violation',
  'command.transport_failure',
  'command.issuer_rotated',
  'command.authority_changed',
  'command.internal_error',
] as const;

export type DeviceCommandCloseReason = typeof DEVICE_COMMAND_CLOSE_REASONS[number];

export interface DeviceCommandExecutionPort {
  execute<T>(operation: () => T | Promise<T>): Promise<T>;
}

export interface DeviceCommandSessionTransport {
  send(message: DeviceCommandResponseMessage): void | Promise<void>;
  close(reason: DeviceCommandCloseReason): void | Promise<void>;
}

export interface DeviceWebSocketCommandSession {
  receiveJson(text: string): Promise<void>;
  dispose(): void;
}

export interface DeviceWebSocketCommandSessionCreateOptions {
  readonly authority: DeviceCredentialAuthority;
  readonly state: DeviceBootstrapSession;
  readonly execution: DeviceCommandExecutionPort;
  readonly transport: DeviceCommandSessionTransport;
}

export interface DeviceWebSocketCommandSessionFactoryPort {
  create(
    options: DeviceWebSocketCommandSessionCreateOptions,
  ): Promise<DeviceWebSocketCommandSession>;
}

export interface DeviceWebSocketCommandSessionFactoryOptions {
  readonly production: Pick<ProductionService, 'executeDeviceVisibilityCommand'>;
  readonly signing: DeviceBootstrapSigningAuthority;
  readonly sendTimeoutMs?: number;
  readonly loadProtocol?: () => Promise<DeviceCommandProtocolModule>;
}

interface TargetLane {
  readonly operationId: string;
  readonly intentKey: string;
  readonly task: Promise<void>;
}

function loadDeviceCommandProtocol(): Promise<DeviceCommandProtocolModule> {
  return import('@overlaykit/protocol/device-command');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameBase(
  request: DeviceCommandExecute,
  evidence: NonNullable<ReturnType<DeviceBootstrapSession['commandEvidence']>>,
): boolean {
  return request.target === evidence.target
    && request.basedOn.issuerKeyId === evidence.issuerKeyId
    && request.basedOn.sequence === evidence.sequence
    && request.basedOn.sha256 === evidence.sha256
    && request.basedOn.productionRevision === evidence.productionRevision
    && request.basedOn.catalogGeneration === evidence.catalogGeneration;
}

function validOutcome(
  value: unknown,
  operationId: string,
  intentHash: string,
): value is ProductionCommandOutcome {
  if (!value || typeof value !== 'object') return false;
  const outcome = value as Partial<ProductionCommandOutcome>;
  const applied = outcome.status === 'applied'
    && outcome.resultCode === 'APPLIED'
    && outcome.expectedRevision === outcome.previousRevision
    && outcome.resultingRevision === (outcome.previousRevision as number) + 1;
  const rejected = outcome.status === 'rejected'
    && outcome.resultCode === 'TARGET_REVISION_CONFLICT'
    && outcome.resultingRevision === outcome.previousRevision;
  return (applied || rejected)
    && Number.isSafeInteger(outcome.globalSequence)
    && (outcome.globalSequence as number) > 0
    && outcome.operationId === operationId
    && outcome.intentHash === intentHash
    && Number.isSafeInteger(outcome.expectedRevision)
    && (outcome.expectedRevision as number) >= 0
    && Number.isSafeInteger(outcome.previousRevision)
    && (outcome.previousRevision as number) >= 0
    && Number.isSafeInteger(outcome.resultingRevision)
    && (outcome.resultingRevision as number) >= 0
    && typeof outcome.replayed === 'boolean';
}

function rejectedOutcome(
  error: ProductionError,
  operationId: string,
  intentHash: string,
): ProductionCommandOutcome | null {
  const details = error.details;
  if (!details || typeof details !== 'object' || !('command' in details)) return null;
  return validOutcome(details.command, operationId, intentHash) ? details.command : null;
}

class MountedDeviceWebSocketCommandSession implements DeviceWebSocketCommandSession {
  private readonly lanes = new Map<'preview' | 'program', TargetLane>();
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly protocol: DeviceCommandProtocolModule,
    private readonly production: Pick<ProductionService, 'executeDeviceVisibilityCommand'>,
    private readonly signing: DeviceBootstrapSigningAuthority,
    private readonly sendTimeoutMs: number,
    private readonly authority: DeviceCredentialAuthority,
    private readonly state: DeviceBootstrapSession,
    private readonly execution: DeviceCommandExecutionPort,
    private readonly transport: DeviceCommandSessionTransport,
  ) {}

  async receiveJson(text: string): Promise<void> {
    if (this.closed) return;
    let request: DeviceCommandExecute;
    try {
      request = this.protocol.parseDeviceCommandExecuteJson(text);
    } catch {
      await this.close('command.protocol_violation');
      return;
    }

    const requestSha256 = sha256(this.protocol.deviceCommandExecuteBytes(request));
    const intentKey = sha256(this.protocol.deviceCommandIntentBytes(request));
    if (!this.isAuthorized(request)) {
      await this.sendRefused(request, requestSha256, 'not_authorized');
      return;
    }

    const active = this.lanes.get(request.target);
    if (active) {
      if (active.operationId === request.operationId) {
        if (active.intentKey === intentKey) {
          await active.task;
        } else {
          await this.sendRefused(request, requestSha256, 'operation_conflict');
        }
        return;
      }
      await this.run(request, requestSha256, false);
      return;
    }

    const task = Promise.resolve()
      .then(() => this.run(request, requestSha256, true))
      .finally(() => {
        if (this.lanes.get(request.target)?.task === task) this.lanes.delete(request.target);
      });
    this.lanes.set(request.target, {
      operationId: request.operationId,
      intentKey,
      task,
    });
    await task;
  }

  dispose(): void {
    this.closed = true;
  }

  private isAuthorized(request: DeviceCommandExecute): boolean {
    return this.authority.targets.includes(request.target)
      && this.authority.scopes.includes('component.visibility:write')
      && this.authority.controlIds.includes(`${request.intent.componentId}.visibility`);
  }

  private async run(
    request: DeviceCommandExecute,
    requestSha256: string,
    allowNew: boolean,
  ): Promise<void> {
    if (this.closed) return;
    const intent: ComponentVisibilityIntent = {
      kind: 'component.visibility',
      showId: this.authority.showId,
      target: request.target,
      componentId: request.intent.componentId,
      visible: request.intent.visible,
      operationId: request.operationId,
      expectedRevision: request.intent.expectedRevision,
    };
    const intentHash = productionVisibilityIntentHash(intent);
    let result: ComponentVisibilityResult;
    try {
      result = await this.execution.execute(() => this.production.executeDeviceVisibilityCommand(
        intent,
        {
          directProgram: request.target === 'program',
          deviceAuthority: this.authority,
          admitNewCommand: () => this.assertNewAdmission(request, allowNew),
        },
      ));
    } catch (error) {
      await this.handleExecutionError(request, requestSha256, intentHash, error);
      return;
    }
    if (!validOutcome(result.command, request.operationId, intentHash)) {
      await this.close('command.internal_error');
      return;
    }
    await this.sendResult(request, result.command);
  }

  private assertNewAdmission(request: DeviceCommandExecute, allowNew: boolean): void {
    if (!allowNew) {
      throw new ProductionError(
        'DEVICE_COMMAND_NOT_READY',
        'Another command is already in flight for this target',
        409,
      );
    }
    const evidence = this.state.commandEvidence(request.target);
    if (!evidence?.ready) {
      throw new ProductionError(
        'DEVICE_COMMAND_NOT_READY',
        'Target lacks current applied state evidence',
        409,
      );
    }
    if (!sameBase(request, evidence)) {
      throw new ProductionError(
        'DEVICE_COMMAND_BASE_MISMATCH',
        'Command does not name the confirmed target base',
        409,
      );
    }
    let issuerKeyId: string;
    try {
      issuerKeyId = this.signing.current().issuerKeyId;
    } catch {
      throw new ProductionError(
        'DEVICE_COMMAND_ISSUER_ROTATED',
        'Current signing authority is unavailable',
        409,
      );
    }
    if (
      issuerKeyId !== evidence.issuerKeyId
      || issuerKeyId !== this.state.confirmedIssuerKeyId()
    ) {
      throw new ProductionError(
        'DEVICE_COMMAND_ISSUER_ROTATED',
        'Signing authority changed after state confirmation',
        409,
      );
    }
  }

  private async handleExecutionError(
    request: DeviceCommandExecute,
    requestSha256: string,
    intentHash: string,
    error: unknown,
  ): Promise<void> {
    if (!(error instanceof ProductionError)) {
      await this.close(
        error instanceof DeviceConnectionAuthorityError
          ? 'command.authority_changed'
          : 'command.internal_error',
      );
      return;
    }
    if (error.code === 'TARGET_REVISION_CONFLICT') {
      const outcome = rejectedOutcome(error, request.operationId, intentHash);
      if (!outcome) {
        await this.close('command.internal_error');
        return;
      }
      await this.sendResult(request, outcome);
      return;
    }
    const refusal = this.refusalFor(error.code);
    if (refusal) {
      await this.sendRefused(request, requestSha256, refusal);
      return;
    }
    if (error.code === 'DEVICE_COMMAND_ISSUER_ROTATED') {
      await this.close('command.issuer_rotated');
      return;
    }
    if (error.code === 'DEVICE_AUTHORITY_CHANGED') {
      await this.close('command.authority_changed');
      return;
    }
    await this.close('command.internal_error');
  }

  private refusalFor(code: string): DeviceCommandRefusalReason | null {
    if (code === 'DEVICE_COMMAND_NOT_READY') return 'not_ready';
    if (code === 'DEVICE_COMMAND_BASE_MISMATCH') return 'base_mismatch';
    if (code === 'OPERATION_ID_CONFLICT') return 'operation_conflict';
    if (code === 'PRODUCTION_COMMAND_JOURNAL_FULL') return 'capacity_exhausted';
    if (
      code === 'PREVIEW_EMPTY'
      || code === 'PROGRAM_EMPTY'
      || code === 'COMPONENT_NOT_FOUND'
      || code === 'AMBIGUOUS_COMPONENT'
      || code === 'PRODUCTION_TARGET_QUARANTINED'
      || code === 'PRODUCTION_COMMAND_SHOW_QUARANTINED'
      || code === 'PRODUCTION_SNAPSHOT_TOO_LARGE'
    ) {
      return 'target_unavailable';
    }
    return null;
  }

  private async sendResult(
    request: DeviceCommandExecute,
    outcome: ProductionCommandOutcome,
  ): Promise<void> {
    let issuerKeyId: string;
    try {
      issuerKeyId = this.requiredCurrentIssuer();
    } catch {
      await this.close('command.issuer_rotated');
      return;
    }
    let payload: DeviceCommandResponsePayload;
    try {
      payload = this.protocol.buildDeviceCommandResultPayload({
        schemaVersion: this.protocol.DEVICE_COMMAND_RESULT_VERSION,
        type: this.protocol.DEVICE_COMMAND_RESULT_TYPE,
        issuerKeyId,
        audienceCredentialId: this.authority.audienceCredentialId,
        operationId: request.operationId,
        intentSha256: outcome.intentHash,
        outcome: outcome.status,
        resultCode: outcome.resultCode,
        commandSequence: outcome.globalSequence,
        expectedRevision: outcome.expectedRevision,
        previousRevision: outcome.previousRevision,
        resultingRevision: outcome.resultingRevision,
        replayed: outcome.replayed,
      });
    } catch {
      await this.close('command.internal_error');
      return;
    }
    await this.signAndSend(payload);
  }

  private async sendRefused(
    request: DeviceCommandExecute,
    requestSha256: string,
    reason: DeviceCommandRefusalReason,
  ): Promise<void> {
    let issuerKeyId: string;
    try {
      issuerKeyId = this.requiredCurrentIssuer();
    } catch {
      await this.close('command.issuer_rotated');
      return;
    }
    let payload: DeviceCommandResponsePayload;
    try {
      payload = this.protocol.buildDeviceCommandRefusedPayload({
        schemaVersion: this.protocol.DEVICE_COMMAND_REFUSED_VERSION,
        type: this.protocol.DEVICE_COMMAND_REFUSED_TYPE,
        issuerKeyId,
        audienceCredentialId: this.authority.audienceCredentialId,
        operationId: request.operationId,
        requestSha256,
        reason,
      });
    } catch {
      await this.close('command.internal_error');
      return;
    }
    await this.signAndSend(payload);
  }

  private requiredCurrentIssuer(): string {
    const confirmed = this.state.confirmedIssuerKeyId();
    const signer = this.signing.current();
    if (!confirmed || signer.issuerKeyId !== confirmed) {
      throw new Error('Device command signer does not match confirmed state authority');
    }
    return signer.issuerKeyId;
  }

  private async signAndSend(payload: DeviceCommandResponsePayload): Promise<void> {
    if (this.closed) return;
    let message: DeviceCommandResponseMessage;
    try {
      const signer = this.signing.current();
      if (signer.issuerKeyId !== payload.issuerKeyId) {
        await this.close('command.issuer_rotated');
        return;
      }
      const payloadBytes = this.protocol.deviceCommandResponsePayloadBytes(payload);
      const signature = await signer.sign(payloadBytes.slice());
      message = await this.protocol.buildDeviceCommandResponseMessage({ payload, signature });
    } catch {
      await this.close('command.internal_error');
      return;
    }
    try {
      await this.sendWithTimeout(message);
    } catch {
      await this.close('command.transport_failure');
    }
  }

  private async sendWithTimeout(message: DeviceCommandResponseMessage): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        Promise.resolve(this.transport.send(message)),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Device command response send timed out')),
            this.sendTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private close(reason: DeviceCommandCloseReason): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    try {
      this.closePromise = Promise.resolve(this.transport.close(reason)).catch(() => undefined);
    } catch {
      this.closePromise = Promise.resolve();
    }
    return this.closePromise;
  }
}

export class DeviceWebSocketCommandSessionFactory
implements DeviceWebSocketCommandSessionFactoryPort {
  private readonly production: Pick<ProductionService, 'executeDeviceVisibilityCommand'>;
  private readonly signing: DeviceBootstrapSigningAuthority;
  private readonly sendTimeoutMs: number;
  private readonly loadProtocol: () => Promise<DeviceCommandProtocolModule>;
  private protocolPromise: Promise<DeviceCommandProtocolModule> | null = null;

  constructor(options: DeviceWebSocketCommandSessionFactoryOptions) {
    if (
      !options
      || !options.production
      || typeof options.production.executeDeviceVisibilityCommand !== 'function'
      || !options.signing
      || typeof options.signing.current !== 'function'
    ) {
      throw new Error('Device WebSocket command session dependencies are invalid');
    }
    const sendTimeoutMs = options.sendTimeoutMs ?? DEVICE_COMMAND_SEND_TIMEOUT_MS;
    if (!Number.isSafeInteger(sendTimeoutMs) || sendTimeoutMs <= 0) {
      throw new Error('Device command send timeout is invalid');
    }
    this.production = options.production;
    this.signing = options.signing;
    this.sendTimeoutMs = sendTimeoutMs;
    this.loadProtocol = options.loadProtocol ?? loadDeviceCommandProtocol;
  }

  async create(
    options: DeviceWebSocketCommandSessionCreateOptions,
  ): Promise<DeviceWebSocketCommandSession> {
    if (
      !options
      || !options.authority
      || !options.state
      || typeof options.state.commandEvidence !== 'function'
      || typeof options.state.confirmedIssuerKeyId !== 'function'
      || !options.execution
      || typeof options.execution.execute !== 'function'
      || !options.transport
      || typeof options.transport.send !== 'function'
      || typeof options.transport.close !== 'function'
    ) {
      throw new Error('Device WebSocket command session options are invalid');
    }
    this.protocolPromise ??= this.loadProtocol();
    const protocol = await this.protocolPromise;
    return new MountedDeviceWebSocketCommandSession(
      protocol,
      this.production,
      this.signing,
      this.sendTimeoutMs,
      options.authority,
      options.state,
      options.execution,
      options.transport,
    );
  }
}
