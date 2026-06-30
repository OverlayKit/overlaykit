<script setup lang="ts">
// Compact mutually-exclusive choice (orientation, mode, density…). v-model.
withDefaults(
  defineProps<{
    modelValue?: string;
    options?: (string | { value: string; label: string })[];
    size?: 'sm' | 'md';
  }>(),
  { options: () => [], size: 'md' }
);
defineEmits<{ (e: 'update:modelValue', v: string): void }>();

function norm(o: string | { value: string; label: string }) {
  return typeof o === 'string' ? { value: o, label: o } : o;
}
</script>

<template>
  <div class="seg" :class="`seg--${size}`" role="tablist">
    <button
      v-for="o in options.map(norm)"
      :key="o.value"
      type="button"
      role="tab"
      class="seg__opt"
      :class="{ 'is-active': modelValue === o.value }"
      :aria-selected="modelValue === o.value"
      @click="$emit('update:modelValue', o.value)"
    >
      {{ o.label }}
    </button>
  </div>
</template>

<style scoped>
.seg {
  display: inline-flex;
  background: var(--surface-inset);
  border: 1px solid var(--app-line);
  border-radius: var(--radius-sm);
  padding: 3px;
  gap: 3px;
}
.seg__opt {
  border: none;
  background: none;
  color: var(--app-muted);
  border-radius: calc(var(--radius-sm) - 2px);
  cursor: pointer;
  font-weight: var(--weight-semibold);
  white-space: nowrap;
  transition: background 0.12s ease, color 0.12s ease;
}
.seg--sm .seg__opt {
  padding: 5px 10px;
  font-size: var(--text-xs);
}
.seg--md .seg__opt {
  padding: 7px 13px;
  font-size: var(--text-sm);
}
.seg__opt:hover {
  color: var(--app-ink);
}
.seg__opt.is-active {
  background: var(--app-raised);
  color: var(--app-ink);
  box-shadow: inset 0 0 0 1px var(--app-accent-line);
}
.seg__opt:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
@media (prefers-reduced-motion: reduce) {
  .seg__opt {
    transition: none;
  }
}
</style>
