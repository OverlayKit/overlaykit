<script setup lang="ts">
// Editor TopBar — unified chrome above every mode (Componente / Layout / Acciones).
// Built entirely from the @overlaykit/ui kit. The mode switch and connection
// status are mode-agnostic; the draft badge + primary action only apply to
// Componente mode (Layout/Acciones own their primaries inside their bodies).
import { Brand, SegmentedControl, Badge, StatusDot, Button } from '@overlaykit/ui';

defineProps<{
  mode: string;
  channel: string;
  dirty?: boolean;
  connected?: boolean;
  sending?: boolean;
  showPrimary?: boolean;
}>();
defineEmits<{
  (e: 'update:mode', v: string): void;
  (e: 'activate'): void;
}>();

const MODE_OPTIONS = [
  { value: 'component', label: 'Componente' },
  { value: 'layout', label: 'Layout' },
  { value: 'actions', label: 'Acciones' },
];
</script>

<template>
  <header class="topbar">
    <Brand :size="18" />
    <SegmentedControl
      :model-value="mode"
      :options="MODE_OPTIONS"
      size="sm"
      @update:model-value="$emit('update:mode', $event)"
    />
    <div class="topbar__show">
      <span class="topbar__show-label">Show</span>
      <span class="topbar__show-value">{{ channel }}</span>
    </div>
    <div class="topbar__spacer" />
    <Badge v-if="showPrimary && dirty" tone="draft" dot>Borrador</Badge>
    <StatusDot
      :state="connected ? 'live' : 'offline'"
      :label="connected ? `CONECTADO · ${channel}` : 'Sin conexión'"
    />
    <Button
      v-if="showPrimary"
      variant="primary"
      size="sm"
      :disabled="sending"
      @click="$emit('activate')"
    >
      {{ sending ? 'Enviando…' : 'Enviar a Preview' }}
    </Button>
  </header>
</template>

<style scoped>
.topbar {
  flex-shrink: 0;
  height: 52px;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 16px;
  background: var(--app-bar);
  border-bottom: 1px solid var(--app-line);
  color: var(--app-ink);
}
.topbar__show {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--text-sm);
}
.topbar__show-label {
  color: var(--app-muted);
  text-transform: uppercase;
  font-size: var(--text-xs);
  letter-spacing: var(--tracking-label);
  font-weight: var(--weight-semibold);
}
.topbar__show-value {
  color: var(--app-ink);
  font-weight: var(--weight-semibold);
}
.topbar__spacer {
  flex: 1;
}
</style>
