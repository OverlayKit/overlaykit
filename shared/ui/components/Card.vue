<script setup lang="ts">
// Raised panel surface. `interactive` adds hover affordance (used by tiles).
withDefaults(
  defineProps<{ padding?: number | string; interactive?: boolean }>(),
  { padding: 18, interactive: false }
);
</script>

<template>
  <div
    class="card"
    :class="{ 'card--interactive': interactive }"
    :style="{ padding: typeof padding === 'number' ? padding + 'px' : padding }"
  >
    <slot />
  </div>
</template>

<style scoped>
.card {
  background: var(--app-panel);
  border: 1px solid var(--app-line);
  border-radius: var(--radius-lg);
}
.card--interactive {
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease;
}
.card--interactive:hover {
  border-color: var(--app-line-strong);
  background: var(--app-raised);
}
@media (prefers-reduced-motion: reduce) {
  .card--interactive {
    transition: none;
  }
}
</style>
