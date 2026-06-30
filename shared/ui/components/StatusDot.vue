<script setup lang="ts">
// Connection / live status. `live` pulses (respecting reduced-motion).
withDefaults(
  defineProps<{ state?: 'connected' | 'offline' | 'idle' | 'live'; label?: string }>(),
  { state: 'connected' }
);
</script>

<template>
  <span class="status" :class="`status--${state}`">
    <span class="status__dot" />
    <span v-if="label" class="status__label">{{ label }}</span>
  </span>
</template>

<style scoped>
.status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--text-sm);
  color: var(--app-muted);
}
.status__dot {
  width: 9px;
  height: 9px;
  border-radius: var(--radius-pill);
  flex: 0 0 auto;
  background: var(--app-faint);
}
.status--connected .status__dot {
  background: var(--state-connected);
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.18);
}
.status--live .status__dot {
  background: var(--state-live);
  box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.2);
  animation: status-pulse 1.8s ease-in-out infinite;
}
.status--offline .status__dot {
  background: var(--state-offline);
}
.status--idle .status__dot {
  background: var(--app-faint);
}
@keyframes status-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
@media (prefers-reduced-motion: reduce) {
  .status--live .status__dot {
    animation: none;
  }
}
</style>
