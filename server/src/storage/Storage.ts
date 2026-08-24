import { Scene } from '../types/scene';
import { ComponentAction } from '../types/element';

export interface ShowRecord {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface CollectionRecord {
  id: string;
  tenantId: string;
  name: string;
  channelId: string;
  scene: Scene;
  variables: Record<string, unknown>;
  updatedAt: number;
  // Persisted, monotonic Scene revision advanced on each save (AC-007). Optional so existing
  // records and in-memory test doubles remain valid; the storage layer assigns it on save.
  revision?: number;
}

export interface CollectionMeta {
  id: string;
  name: string;
  channelId: string;
  elementCount: number;
  updatedAt: number;
  revision?: number;
}

export interface ActionRecord {
  id: string;
  tenantId: string;
  name: string;
  icon?: string;
  channelId?: string;
  actions: ComponentAction[];
  updatedAt: number;
}

export interface Storage {
  init(): Promise<void>;
  listShows(includeArchived?: boolean): Promise<ShowRecord[]>;
  getShow(id: string): Promise<ShowRecord | null>;
  saveShow(record: ShowRecord): Promise<ShowRecord>;
  archiveShow(id: string, archivedAt: number): Promise<ShowRecord | null>;
  listCollections(tenantId: string): Promise<CollectionMeta[]>;
  getCollection(tenantId: string, id: string): Promise<CollectionRecord | null>;
  saveCollection(record: CollectionRecord): Promise<CollectionRecord>;
  deleteCollection(tenantId: string, id: string): Promise<boolean>;
  listActions(tenantId: string): Promise<ActionRecord[]>;
  getAction(tenantId: string, id: string): Promise<ActionRecord | null>;
  saveAction(record: ActionRecord): Promise<void>;
  deleteAction(tenantId: string, id: string): Promise<boolean>;
}

export function toMeta(c: CollectionRecord): CollectionMeta {
  return {
    id: c.id,
    name: c.name,
    channelId: c.channelId,
    elementCount: c.scene?.elements?.length || 0,
    updatedAt: c.updatedAt,
    revision: c.revision,
  };
}
