import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { ElementNode } from '../types/element';
import { Scene } from '../types/scene';

export interface ChannelState {
  elements: Map<string, ElementNode>;
  scene?: Scene;
  isConnected: boolean;
  isConnecting: boolean;
}

export const useChannelStore = defineStore('channels', () => {
  // State
  const channels = ref<Map<string, ChannelState>>(new Map());

  // Getters
  const getChannel = computed(() => {
    return (channelId: string): ChannelState | undefined => {
      return channels.value.get(channelId);
    };
  });

  const getElements = computed(() => {
    return (channelId: string): ElementNode[] => {
      const channel = channels.value.get(channelId);
      if (!channel) return [];
      return Array.from(channel.elements.values());
    };
  });

  const getElement = computed(() => {
    return (channelId: string, elementId: string): ElementNode | undefined => {
      const channel = channels.value.get(channelId);
      return channel?.elements.get(elementId);
    };
  });

  // Actions
  function initializeChannel(channelId: string): void {
    if (!channels.value.has(channelId)) {
      channels.value.set(channelId, {
        elements: new Map(),
        isConnected: false,
        isConnecting: false,
      });
    }
  }

  function setChannelConnecting(channelId: string, isConnecting: boolean): void {
    const channel = channels.value.get(channelId);
    if (channel) {
      channel.isConnecting = isConnecting;
    }
  }

  function setChannelConnected(channelId: string, isConnected: boolean): void {
    const channel = channels.value.get(channelId);
    if (channel) {
      channel.isConnected = isConnected;
    }
  }

  function addElement(channelId: string, element: ElementNode): void {
    initializeChannel(channelId);
    const channel = channels.value.get(channelId);
    if (channel) {
      channel.elements.set(element.id, element);
      // Forzar reactividad creando un nuevo Map
      channels.value = new Map(channels.value);
    }
  }

  function updateElement(
    channelId: string,
    elementId: string,
    updates: Partial<ElementNode>
  ): void {
    const channel = channels.value.get(channelId);
    if (!channel) return;

    const existing = channel.elements.get(elementId);
    if (!existing) return;

    const updated = { ...existing, ...updates };
    channel.elements.set(elementId, updated);
    // Forzar reactividad creando un nuevo Map
    channels.value = new Map(channels.value);
  }

  function removeElement(channelId: string, elementId: string): void {
    const channel = channels.value.get(channelId);
    if (channel) {
      channel.elements.delete(elementId);
      // Forzar reactividad creando un nuevo Map
      channels.value = new Map(channels.value);
    }
  }

  function setScene(channelId: string, scene: Scene): void {
    initializeChannel(channelId);
    const channel = channels.value.get(channelId);
    if (channel) {
      channel.scene = scene;
      // Clear existing elements and add scene elements
      channel.elements.clear();
      if (scene.elements) {
        for (const element of scene.elements) {
          channel.elements.set(element.id, element);
        }
      }
      // Forzar reactividad creando un nuevo Map
      channels.value = new Map(channels.value);
    }
  }

  function clearElements(channelId: string): void {
    const channel = channels.value.get(channelId);
    if (channel) {
      channel.elements.clear();
      // Forzar reactividad creando un nuevo Map
      channels.value = new Map(channels.value);
    }
  }

  return {
    // State
    channels,

    // Getters
    getChannel,
    getElements,
    getElement,

    // Actions
    initializeChannel,
    setChannelConnecting,
    setChannelConnected,
    addElement,
    updateElement,
    removeElement,
    setScene,
    clearElements,
  };
});
