import { Scene } from '../types/scene';
import { ComponentAction } from '../types/element';

export interface CollectionRecord {
  id: string;
  tenantId: string;
  name: string;
  channelId: string;
  scene: Scene;
  variables: Record<string, unknown>;
  updatedAt: number;
}

export interface CollectionMeta {
  id: string;
  name: string;
  channelId: string;
  elementCount: number;
  updatedAt: number;
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
  };
}
