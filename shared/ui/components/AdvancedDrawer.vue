<script setup lang="ts">
// Progressive disclosure: technical internals (REST/WS, payloads, URL params)
// live here, collapsed by default. The cardinal "power without exposure" tool.
import { ref } from 'vue';
const props = withDefaults(
  defineProps<{ label?: string; defaultOpen?: boolean }>(),
  { label: 'Avanzado', defaultOpen: false }
);
const open = ref(props.defaultOpen);
</script>

<template>
  <div class="drawer" :class="{ 'is-open': open }">
    <button
      type="button"
      class="drawer__head"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="drawer__caret" aria-hidden="true">▸</span>
      <span class="drawer__label">{{ label }}</span>
    </button>
    <div v-if="open" class="drawer__body"><slot /></div>
  </div>
</template>

<style scoped>
.drawer {
  border-top: 1px solid var(--app-line);
  padding-top: 10px;
}
.drawer__head {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: none;
  border: none;
  color: var(--app-muted);
  cursor: pointer;
  padding: 2px 0;
  font-size: var(--text-sm);
}
.drawer__head:hover {
  color: var(--app-ink);
}
.drawer__head:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.drawer__caret {
  transition: transform 0.14s ease;
  font-size: 11px;
}
.drawer.is-open .drawer__caret {
  transform: rotate(90deg);
}
.drawer__body {
  margin-top: 10px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--app-faint);
  line-height: var(--leading-normal);
  background: var(--surface-inset);
  border: 1px solid var(--app-line);
  border-radius: var(--radius-sm);
  padding: 11px 13px;
}
@media (prefers-reduced-motion: reduce) {
  .drawer__caret {
    transition: none;
  }
}
</style>
