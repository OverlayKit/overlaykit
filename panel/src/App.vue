<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { ControlValue, ProductionSnapshot, ProductionState } from '@overlaykit/protocol';
import { OperatorControls, StatusDot } from '@overlaykit/ui';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8080';
const params = new URLSearchParams(location.search);
const showId = params.get('show') || '';
const embedded = params.get('embedded') === 'true';

const snapshot = ref<ProductionSnapshot | null>(null);
const connection = ref<'connected' | 'disconnected'>('disconnected');
const applying = ref(false);
const error = ref('');
let socket: WebSocket | null = null;
let reconnectTimer: number | undefined;

const connectionState = computed(() => connection.value === 'connected' ? 'connected' : 'offline');
const connectionLabel = computed(() => connection.value === 'connected' ? 'Preview connected' : 'Preview disconnected');

async function refresh(): Promise<void> {
  if (!showId) return;
  const response = await fetch(`${API_URL}/api/shows/${encodeURIComponent(showId)}/production`, {
    credentials: 'include',
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to Studio to operate Preview' : 'Preview is unavailable');
  const payload = await response.json() as { data: ProductionState };
  snapshot.value = payload.data.preview;
}

async function applyControls(values: Record<string, ControlValue>): Promise<void> {
  if (!showId || !snapshot.value || applying.value) return;
  applying.value = true;
  error.value = '';
  try {
    const response = await fetch(`${API_URL}/api/shows/${encodeURIComponent(showId)}/production/preview/controls`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedPreviewRevision: snapshot.value.revision,
        operationId: crypto.randomUUID(),
        values,
      }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(payload?.error?.message || 'Preview controls could not be applied');
    }
    const payload = await response.json() as { data: ProductionState };
    snapshot.value = payload.data.preview;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Preview controls could not be applied';
    await refresh().catch(() => undefined);
  } finally {
    applying.value = false;
  }
}

function connect(): void {
  if (!showId || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  socket = new WebSocket(WS_URL);
  socket.onopen = () => {
    connection.value = 'connected';
    socket?.send(JSON.stringify({ type: 'subscribe.production', showId, bus: 'preview' }));
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as {
      type?: string;
      bus?: string;
      snapshot?: ProductionSnapshot;
    };
    if (
      (message.type === 'production.subscription.confirmed' || message.type === 'production.snapshot')
      && message.bus === 'preview'
      && message.snapshot
    ) {
      snapshot.value = message.snapshot;
    }
  };
  socket.onclose = () => {
    connection.value = 'disconnected';
    reconnectTimer = window.setTimeout(connect, 2000);
  };
  socket.onerror = () => socket?.close();
}

onMounted(async () => {
  if (!showId) {
    error.value = 'Open the Panel from a Show in Studio.';
    return;
  }
  await refresh().catch((cause: unknown) => {
    error.value = cause instanceof Error ? cause.message : 'Preview is unavailable';
  });
  connect();
});

onUnmounted(() => {
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  if (socket) socket.onclose = null;
  socket?.close();
});
</script>

<template>
  <div class="panel-shell">
    <header v-if="!embedded" class="panel-header">
      <div>
        <span class="panel-eyebrow">OVERLAYKIT</span>
        <strong>Preview controls</strong>
      </div>
      <StatusDot :state="connectionState" :label="connectionLabel" />
    </header>

    <main class="panel-main">
      <div v-if="snapshot" class="panel-context">
        <div>
          <span>Loaded scene</span>
          <strong>{{ snapshot.scene?.name || 'Preview clear' }}</strong>
        </div>
        <b>REV {{ snapshot.revision }}</b>
      </div>

      <OperatorControls
        :controls="snapshot?.controls || []"
        :busy="applying"
        :disabled="connection !== 'connected' || !snapshot?.scene"
        :error="error"
        @apply="applyControls"
      />
    </main>
  </div>
</template>

<style scoped>
.panel-shell { min-height: 100vh; background: var(--app-bg); color: var(--app-ink); }
.panel-header { min-height: 58px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--app-line); background: var(--app-panel); padding: 0 20px; }
.panel-header > div { display: grid; gap: 2px; }
.panel-header strong { font-size: 14px; }
.panel-eyebrow { color: var(--app-accent); font-size: 9px; font-weight: 800; letter-spacing: 0; }
.panel-main { width: min(880px, 100%); box-sizing: border-box; margin: 0 auto; padding: 20px; }
.panel-context { display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--app-line); margin-bottom: 18px; padding-bottom: 14px; }
.panel-context > div { display: grid; flex: 1; min-width: 0; gap: 3px; }
.panel-context span { color: var(--app-muted); font-size: 10px; }
.panel-context strong { font-size: 15px; }
.panel-context b { border: 1px solid var(--app-line); border-radius: var(--radius-sm); color: var(--app-muted); padding: 5px 7px; font-size: 10px; }
@media (max-width: 560px) {
  .panel-header { align-items: flex-start; flex-direction: column; min-height: 0; padding: 12px 14px; }
  .panel-header > div { width: 100%; }
  .panel-main { padding: 16px 14px; }
}
</style>
