<template>
  <div
    ref="containerRef"
    class="production-container"
    :class="{ transparent: isTransparent }"
    :data-orientation="orientation"
  >
    <div
      v-show="showStatus && !hideStatus"
      class="connection-status"
      :class="{
        connected: wsAdapter.isConnected(),
        connecting: connectionState === 'connecting',
        disconnected: connectionState === 'disconnected',
        error: connectionState === 'error',
      }"
    >
      <span class="status-indicator" />
      {{ connectionStatusText }}
    </div>

    <div
      class="stage"
      :style="stageStyle"
    >
      <div
        class="elements-container"
        :data-motion="motionOff ? 'off' : undefined"
      >
        <template
          v-for="item in staggeredElements"
          :key="item.element.id"
        >
          <ElementRenderer
            :element="item.element"
            :variables="variables"
            :stagger-index="item.staggerIndex"
            :on-element-remove="removeElement"
            :on-action="dispatchAction"
          />
        </template>
      </div>
    </div>

    <div
      v-if="!hideWatermark"
      class="watermark"
    >
      OverlayKit
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import { useChannelStore } from '../store/channels';
import { useVariablesStore } from '../store/variables';
import { WebSocketAdapter } from '../modules/ws/WebSocketAdapter';
import { soundManager } from '@overlaykit/renderer/services/SoundManager';
import { injectMotionPatterns } from '@overlaykit/renderer/services/motionPatterns';
import { logger } from '../utils/logger';
import ElementRenderer from '@overlaykit/renderer/components/ElementRenderer.vue';
import type { ElementNode, Variables, Scene, ComponentAction } from '../types/element';

interface QueryParams {
  channel?: string;
  transparent?: string;
  fullscreen?: string;
  hideStatus?: string;
  hideWatermark?: string;
  autoConnect?: string;
  token?: string;
  readOnly?: string;
}

interface WebSocketMessage {
  type: string;
  channelId?: string;
  state?: {
    elements?: ElementNode[];
    variables?: Variables;
    designSystem?: { name?: string; css?: string; tokens?: Record<string, string> };
    orientation?: 'landscape' | 'portrait';
  };
  designSystem?: { name?: string; css?: string; tokens?: Record<string, string> };
  orientation?: 'landscape' | 'portrait';
  element?: ElementNode;
  id?: string;
  updates?: Partial<ElementNode>;
  scene?: Scene;
  variables?: Variables;
  elements?: ElementNode[];
  sound?: { url: string; volume?: number; loop?: boolean };
  code?: string;
  message?: string;
  payload?: {
    componentId?: string;
    elementsCount?: number;
  };
  [key: string]: unknown;
}

const route = useRoute();
const channelStore = useChannelStore();
const variablesStore = useVariablesStore();

// State
const rawOutputToken = new URLSearchParams(location.search).get('token');
const rawWsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:8080';
const authenticatedWsUrl = new URL(rawWsUrl);
if (rawOutputToken) authenticatedWsUrl.searchParams.set('token', rawOutputToken);
const wsAdapter = new WebSocketAdapter(authenticatedWsUrl.toString());
const connectionState = ref<'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'>(
  'disconnected'
);
const showStatus = ref(true);

// Canvas orientation (from the server scene/channel). Drives the 16:9 vs 9:16
// stage so a portrait scene composes correctly on the overlay; the stage is
// scaled to fit the browser source (1:1 when the source matches the canvas).
const orientation = ref<'landscape' | 'portrait'>('landscape');
const stageDims = computed(() =>
  orientation.value === 'portrait' ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 }
);
const containerRef = ref<HTMLElement | null>(null);
const stageScale = ref(1);
let resizeObserver: ResizeObserver | undefined;

function recomputeScale(): void {
  const el = containerRef.value;
  if (!el) return;
  const { w, h } = stageDims.value;
  const s = Math.min(el.clientWidth / w, el.clientHeight / h);
  stageScale.value = s > 0 ? s : 1;
}

const stageStyle = computed(() => ({
  width: stageDims.value.w + 'px',
  height: stageDims.value.h + 'px',
  transform: `translate(-50%, -50%) scale(${stageScale.value})`,
}));

function applyOrientation(o: unknown): void {
  if (o === 'landscape' || o === 'portrait') orientation.value = o;
}

// Props from query parameters
const params = computed<QueryParams>(() => ({
  channel: route.query.channel as string | undefined,
  transparent: route.query.transparent as string | undefined,
  fullscreen: route.query.fullscreen as string | undefined,
  hideStatus: route.query.hideStatus as string | undefined,
  hideWatermark: route.query.hideWatermark as string | undefined,
  autoConnect: route.query.autoConnect as string | undefined,
  token: route.query.token as string | undefined,
  readOnly: route.query.readOnly as string | undefined,
}));

const isTransparent = computed(() => params.value.transparent === 'true');
const hideStatus = computed(() => params.value.hideStatus === 'true');
const hideWatermark = computed(() => params.value.hideWatermark === 'true');
const autoConnect = computed(() => params.value.autoConnect !== 'false');
const readOnlyOutput = computed(() => Boolean(params.value.token) || params.value.readOnly === 'true');

const channelId = computed(() => params.value.channel || 'main');
const variables = computed(() => variablesStore.getVariables(channelId.value));

// Motion System kill switch: flags.motion === false neutralizes all motion for the
// channel (sets data-motion="off" on the container; the patterns CSS zeroes the
// tokens). Any other value (or unset) leaves motion on.
const motionOff = computed(() => {
  const flags = (variables.value as Record<string, any>)?.flags;
  return flags?.motion === false || flags?.motion === 'false';
});
const activeElements = computed(() => channelStore.getElements(channelId.value));

// Motion System: pair each top-level element with its visual index (skipping the
// non-visual <style> theme node) so DS component entrances stagger on a scene intro.
const staggeredElements = computed(() =>
  activeElements.value.reduce<{ element: typeof activeElements.value[number]; staggerIndex?: number }[]>(
    (acc, element) => {
      acc.push({ element, staggerIndex: element.tag === 'style' ? undefined : acc.filter((e) => e.staggerIndex !== undefined).length });
      return acc;
    },
    []
  )
);

const connectionStatusText = computed(() => {
  switch (connectionState.value) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting...';
    case 'disconnected':
      return 'Disconnected';
    case 'reconnecting':
      return 'Reconnecting...';
    case 'error':
      return 'Connection Error';
    default:
      return 'Unknown';
  }
});



// Lifecycle
onMounted(() => {
  logger.info('ProductionView mounted', { channelId: channelId.value });

  // Motion System: ship the theme-independent motion-patterns stylesheet once.
  // Design-system motion tokens arrive via the existing :root{--ds-*} path.
  injectMotionPatterns();

  // Size the stage to the browser source, and keep it in sync on resize and
  // whenever the orientation changes.
  recomputeScale();
  resizeObserver = new ResizeObserver(() => recomputeScale());
  if (containerRef.value) resizeObserver.observe(containerRef.value);
  watch(stageDims, () => recomputeScale());

  // Setup WebSocket handlers
  wsAdapter.onMessage((message) => {
    handleWebSocketMessage(message);
  });

  wsAdapter.onStateChange((state) => {
    connectionState.value = state;
  });

  wsAdapter.onError((error) => {
    logger.error('WebSocket error', { error: error.message });
  });

  // Auto-connect if enabled
  if (autoConnect.value) {
    connectWebSocket();
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  wsAdapter.disconnect();
  soundManager.stopAll();
});

// Methods
async function connectWebSocket(): Promise<void> {
  try {
    logger.info('Connecting to WebSocket', { url: import.meta.env.VITE_WS_URL });

    await wsAdapter.connect();

    const subscribeMessage = { type: 'subscribe', channelId: channelId.value };

    wsAdapter.send(subscribeMessage);
  } catch (error) {
    logger.error('Failed to connect WebSocket', { error: String(error) });
  }
}

// Inject/replace the live design-system tokens (--ds-*) as a <style> in <head>,
// so DS components re-skin instantly when a theme is pushed (API/composer).
function applyDesignSystem(ds: { css?: string } | null | undefined): void {
  const id = 'dom-ds-live';
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!ds || !ds.css) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = id;
  }
  // append at the end of <body> so this live override wins over any :root theme
  // baked into the activated scene (which renders inside #app).
  document.body.appendChild(el);
  el.textContent = ds.css;
}

// 'mounted' triggers fire once per element-id for the overlay's lifetime. A
// scene.activate action clears+re-adds elements, which re-runs onMounted; without
// this guard a mounted→scene.activate trigger (or two mutually-activating scenes)
// would loop unbounded. Never cleared, so the cycle breaks after one pass.
const firedMounted = new Set<string>();

// Feature B: a component trigger (countdown reaches 0, click, mounted) reports its
// actions here; we relay them to the server, which dispatches them authoritatively
// to every subscriber — so all overlays react in sync and remote webhooks reuse
// the exact same path.
async function dispatchAction(actions: ComponentAction[], sourceId: string, triggerType: string): Promise<void> {
  if (!actions?.length) return;
  if (readOnlyOutput.value) {
    logger.warn('Output action ignored because this runtime is read-only', { sourceId, triggerType });
    return;
  }
  if (triggerType === 'mounted') {
    if (firedMounted.has(sourceId)) return;
    firedMounted.add(sourceId);
  }
  const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';
  try {
    const res = await fetch(`${API}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: channelId.value, actions }),
    });
    if (!res.ok) {
      logger.warn('Event dispatch rejected', { sourceId, status: res.status });
      return;
    }
    const body = await res.json().catch(() => null);
    if (body?.data?.errors?.length) {
      logger.warn('Some component actions failed', { sourceId, errors: body.data.errors });
    }
  } catch (error) {
    logger.error('Failed to dispatch component action', { sourceId, error: String(error) });
  }
}

function handleWebSocketMessage(message: WebSocketMessage): void {
  const { type, channelId: msgChannelId } = message;

  // Only process messages for our channel
  if (msgChannelId && msgChannelId !== channelId.value) {
    return;
  }

  // Use the message channelId or fallback to our subscribed channel
  const targetChannelId = msgChannelId || channelId.value;

  switch (type) {
    case 'subscription.confirmed':
      logger.info('Subscription confirmed', { channelId: targetChannelId });
      if (message.state?.elements) {
        for (const element of message.state.elements) {
          channelStore.addElement(targetChannelId, element);
        }
      }
      if (message.state?.variables) {
        variablesStore.setVariables(targetChannelId, message.state.variables);
      }
      if (message.state?.designSystem) {
        applyDesignSystem(message.state.designSystem);
      }
      applyOrientation(message.state?.orientation);
      break;

    case 'element.create':
      if (message.element) {
        logger.debug('Element created via WebSocket', { elementId: message.element.id });
        channelStore.addElement(targetChannelId, message.element);
      }
      break;

    case 'element.update':
      if (message.id && message.updates) {
        logger.debug('Element updated via WebSocket', { elementId: message.id });
        channelStore.updateElement(targetChannelId, message.id, message.updates);
      }
      break;

    case 'element.delete':
      if (message.id) {
        logger.debug('Element deleted via WebSocket', { elementId: message.id });
        channelStore.removeElement(targetChannelId, message.id);
      }
      break;

    case 'scene.activated':
      logger.debug('Scene activated via WebSocket', {
        sceneId: message.scene?.id,
        sceneName: message.scene?.name
      });
      applyOrientation(message.scene?.orientation ?? message.orientation);

      // Set scene elements
      if (message.scene?.elements) {
        channelStore.clearElements(targetChannelId);
        for (const element of message.scene.elements) {
          channelStore.addElement(targetChannelId, element);
        }
      }

      // Update variables from scene activation
      if (message.variables) {
        variablesStore.setVariables(targetChannelId, message.variables);
      }

      // Play background music if present
      if (message.scene?.backgroundMusic) {
        soundManager.playBackgroundMusic(message.scene.backgroundMusic);
      }
      break;

    case 'variables.update':
      if (message.variables) {
        logger.debug('Variables updated via WebSocket');
        variablesStore.setVariables(targetChannelId, message.variables);
      }
      break;

    case 'design.system':
      // Live theme push (from the API or composer): re-skin DS components
      // without re-activating the scene.
      logger.debug('Design system updated via WebSocket', { name: message.designSystem?.name });
      applyDesignSystem(message.designSystem);
      break;

    case 'sound.play':
      // Feature B: one-shot sound dispatched by a component action / webhook.
      if (message.sound) {
        soundManager.playSound(message.sound).catch((error) => {
          logger.warn('Failed to play action sound', { error: String(error) });
        });
      }
      break;

    case 'elements.updated':
      logger.debug('Elements updated via WebSocket', { count: message.elements?.length || 0 });

      applyOrientation(message.orientation);

      // Actualizar variables si vienen en el mensaje
      if (message.variables) {
        variablesStore.setVariables(targetChannelId, message.variables);
      }

      // Limpiar elementos existentes y cargar los nuevos
      channelStore.clearElements(targetChannelId);

      if (message.elements && Array.isArray(message.elements)) {
        for (const element of message.elements) {
          // Los elementos ya vienen en formato ElementNode del servidor
          channelStore.addElement(targetChannelId, element);
        }
      }
      break;

    case 'component_deployed':
      logger.debug('Component deployed confirmation', { 
        componentId: message.payload?.componentId,
        elementsCount: message.payload?.elementsCount 
      });
      // Este mensaje es solo confirmación, los elementos llegan en 'elements.updated'
      break;

    case 'error':
      logger.error('WebSocket error message', { code: message.code, message: message.message });
      break;

    case 'pong':
      // Heartbeat response
      break;

    default:
      logger.warn('Unknown WebSocket message type', { type });
  }
}

function removeElement(elementId: string): void {
  logger.debug('Removing element', { elementId });
  channelStore.removeElement(channelId.value, elementId);
}
</script>

<style scoped>
.production-container {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: #000;
  overflow: hidden;
  font-family: Arial, sans-serif;
  z-index: 1;
}

.production-container.transparent {
  background-color: transparent;
}

/* Fixed design-space stage (1920×1080 landscape / 1080×1920 portrait), centered
   and scaled to fit the browser source — 1:1 when the source matches the canvas.
   width/height/transform come from :style; letterbox areas stay transparent. */
.stage {
  position: absolute;
  top: 50%;
  left: 50%;
  transform-origin: center center;
}

.elements-container {
  position: relative;
  width: 100%;
  height: 100%;
}

.connection-status {
  position: fixed;
  top: 10px;
  right: 10px;
  padding: 8px 12px;
  background-color: rgba(0, 0, 0, 0.7);
  color: #fff;
  border-radius: 4px;
  font-size: 12px;
  z-index: 1000;
  display: flex;
  align-items: center;
  gap: 6px;
}

.status-indicator {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  animation: pulse 1s infinite;
}

.connection-status.connected .status-indicator {
  background-color: #4caf50;
}

.connection-status.connecting .status-indicator {
  background-color: #ff9800;
}

.connection-status.disconnected .status-indicator {
  background-color: #f44336;
  animation: none;
}

.connection-status.error .status-indicator {
  background-color: #f44336;
}

@keyframes pulse {
  0% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
  100% {
    opacity: 1;
  }
}

.watermark {
  position: fixed;
  bottom: 10px;
  right: 10px;
  color: rgba(255, 255, 255, 0.2);
  font-size: 12px;
  z-index: 999;
}
</style>
