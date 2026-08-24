import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { PNG } from 'pngjs';
import type { ViteDevServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';
import { expect } from 'vitest';
import { resolveAnnouncePersonProgram } from '@overlaykit/visual-compiler';
import type { VisualContextFacts, VisualIntent } from '@overlaykit/visual-protocol';
import {
  compileOverlayKitDomProgram,
  prepareOverlayKitPreviewCandidate,
  type OverlayKitDomProgramArtifact,
} from '@overlaykit/visual-target-overlaykit';
import type {
  ActionRecord,
  CollectionMeta,
  CollectionRecord,
  ShowRecord,
  Storage,
} from '../../../src/storage';

/**
 * Shared, side-effect-free helpers for the governed Output proofs (CHG-0045, CHG-0046 and their
 * successors). Nothing here touches the network on import.
 */

export const VIEWPORT = { width: 1920, height: 1080 } as const;
export const SHOW_ID = 'output-authority-show';
export const OTHER_SHOW_ID = 'output-authority-other-show';
export const ORIGIN_OWNER = {
  email: 'owner@overlaykit.local',
  displayName: 'Local Owner',
  password: 'correct horse battery staple',
};
export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

export class TestStorage implements Storage {
  private readonly shows = new Map<string, ShowRecord>([
    [
      SHOW_ID,
      {
        id: SHOW_ID,
        name: 'Authorized Output',
        description: 'CHG-0045 proof Show',
        createdAt: 1,
        updatedAt: 1,
        archivedAt: null,
      },
    ],
    [
      OTHER_SHOW_ID,
      {
        id: OTHER_SHOW_ID,
        name: 'Other Output',
        description: 'Cross-Show denial target',
        createdAt: 1,
        updatedAt: 1,
        archivedAt: null,
      },
    ],
  ]);

  async init(): Promise<void> {}
  async listShows(includeArchived = false): Promise<ShowRecord[]> {
    return [...this.shows.values()].filter((show) => includeArchived || show.archivedAt === null);
  }
  async getShow(id: string): Promise<ShowRecord | null> {
    return this.shows.get(id) ?? null;
  }
  async saveShow(show: ShowRecord): Promise<ShowRecord> {
    this.shows.set(show.id, show);
    return show;
  }
  async archiveShow(id: string, archivedAt: number): Promise<ShowRecord | null> {
    const show = this.shows.get(id);
    if (!show) return null;
    const archived = { ...show, archivedAt, updatedAt: archivedAt };
    this.shows.set(id, archived);
    return archived;
  }
  async listCollections(_tenantId: string): Promise<CollectionMeta[]> {
    return [];
  }
  async getCollection(_tenantId: string, _id: string): Promise<CollectionRecord | null> {
    return null;
  }
  async saveCollection(record: CollectionRecord): Promise<CollectionRecord> {
    return record;
  }
  async deleteCollection(_tenantId: string, _id: string): Promise<boolean> {
    return false;
  }
  async listActions(_tenantId: string): Promise<ActionRecord[]> {
    return [];
  }
  async getAction(_tenantId: string, _id: string): Promise<ActionRecord | null> {
    return null;
  }
  async saveAction(_record: ActionRecord): Promise<void> {}
  async deleteAction(_tenantId: string, _id: string): Promise<boolean> {
    return false;
  }
}

export interface CompiledFixture {
  artifact: OverlayKitDomProgramArtifact;
  candidate: ReturnType<typeof prepareOverlayKitPreviewCandidate>;
  name: string;
  programId: string;
  role: string;
}

export interface PixelMetrics {
  colorCount: number;
  opaquePixels: number;
  screenshotHash: string;
  totalPixels: number;
  transparentPixels: number;
  visiblePixels: number;
}

export function visualContext(): VisualContextFacts {
  return {
    surface: 'broadcast.overlay',
    viewport: { ...VIEWPORT, pixelRatio: 1, transparent: true },
    temporalMode: 'live',
    interaction: 'operator',
    safeAreas: [{ x: 64, y: 64, width: 1792, height: 952 }],
    expectedDuration: 6_000,
    audienceDistance: 'medium',
    attentionBudget: 'medium',
    reducedMotion: true,
    capabilities: {
      dom: true,
      svg: true,
      canvas: false,
      cssAnimations: true,
      webAnimations: false,
      audio: false,
    },
  };
}

export function compiledFixture(id: string, name: string, role: string): CompiledFixture {
  const intent: VisualIntent = {
    id,
    task: 'announce',
    subject: { type: 'person', name, role },
    desiredEffect: 'notice',
    importance: 'primary',
  };
  const program = resolveAnnouncePersonProgram({ intent, context: visualContext() });
  const artifact = compileOverlayKitDomProgram(program);
  return {
    artifact,
    candidate: prepareOverlayKitPreviewCandidate(artifact, {
      'person-name': name,
      'person-role': role,
    }),
    name,
    programId: program.id,
    role,
  };
}

export function serverPort(server: Server | WebSocketServer | ViteDevServer): number {
  const address =
    server instanceof WebSocketServer
      ? server.address()
      : 'httpServer' in server
        ? server.httpServer?.address()
        : server.address();
  if (!address || typeof address === 'string') throw new Error('Proof server has no TCP port');
  return address.port;
}

export function openWebSocket(url: string, origin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, [], { origin });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

export async function authenticateOutput(socket: WebSocket, token: string): Promise<void> {
  const authenticated = nextMessage(socket);
  socket.send(JSON.stringify({ type: 'authenticate.output', token }));
  expect(await authenticated).toMatchObject({
    type: 'authentication.confirmed',
    access: 'output',
  });
}

export function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once('message', (data) =>
      resolve(JSON.parse(data.toString()) as Record<string, unknown>)
    );
  });
}

export function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', resolve));
}

export function pixelMetrics(buffer: Buffer): PixelMetrics {
  const png = PNG.sync.read(buffer);
  let opaquePixels = 0;
  let transparentPixels = 0;
  let visiblePixels = 0;
  const colors = new Set<number>();
  for (let index = 0; index < png.data.length; index += 4) {
    const alpha = png.data[index + 3];
    if (alpha === 0) transparentPixels += 1;
    if (alpha === 255) opaquePixels += 1;
    if (alpha > 0) {
      visiblePixels += 1;
      if (colors.size < 4096) {
        colors.add((png.data[index] << 16) | (png.data[index + 1] << 8) | png.data[index + 2]);
      }
    }
  }
  return {
    totalPixels: png.width * png.height,
    visiblePixels,
    opaquePixels,
    transparentPixels,
    colorCount: colors.size,
    screenshotHash: createHash('sha256').update(buffer).digest('hex'),
  };
}

export async function waitForText(page: Page, fixture: CompiledFixture): Promise<void> {
  await page.locator(`#${fixture.programId}-name`).filter({ hasText: fixture.name }).waitFor({
    state: 'visible',
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map((animation) => animation.finished));
  });
}

/**
 * Server-side observation of every WebSocket connection: the upgrade request target, the client's
 * User-Agent and Origin headers, the order of incoming application message types and the order of
 * outgoing message types. Tokens are never retained: only the `type` field of each JSON frame is
 * recorded.
 */
export interface ObservedConnection {
  closeCode: number | null;
  origin: string;
  receivedTypes: string[];
  sentTypes: string[];
  upgradeTarget: string;
  userAgent: string;
}

export function observeConnections(wsServer: WebSocketServer): ObservedConnection[] {
  const observed: ObservedConnection[] = [];
  wsServer.on('connection', (socket: WebSocket, incoming: IncomingMessage) => {
    const record: ObservedConnection = {
      closeCode: null,
      origin: String(incoming.headers.origin ?? ''),
      receivedTypes: [],
      sentTypes: [],
      upgradeTarget: incoming.url ?? '',
      userAgent: String(incoming.headers['user-agent'] ?? ''),
    };
    observed.push(record);
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as { type?: unknown };
        if (typeof message.type === 'string') record.receivedTypes.push(message.type);
      } catch {
        // Non-JSON frames carry no production message type.
      }
    });
    const originalSend = socket.send.bind(socket);
    socket.send = ((data: unknown, ...rest: unknown[]) => {
      try {
        const message = JSON.parse(String(data)) as { type?: unknown };
        if (typeof message.type === 'string') record.sentTypes.push(message.type);
      } catch {
        // Non-JSON frames carry no production message type.
      }
      return (originalSend as (...args: unknown[]) => unknown)(data, ...rest);
    }) as typeof socket.send;
    socket.once('close', (code: number) => {
      record.closeCode = code;
    });
  });
  return observed;
}
