<script setup lang="ts">
// Square glyph button (zoom, close, menu…). Label is required for a11y.
withDefaults(defineProps<{ label: string; size?: 'sm' | 'md' }>(), { size: 'md' });
</script>

<template>
  <button
    type="button"
    class="iconbtn"
    :class="`iconbtn--${size}`"
    :aria-label="label"
    :title="label"
  >
    <slot />
  </button>
</template>

<style scoped>
.iconbtn {
  display: inline-grid;
  place-items: center;
  border: 1px solid var(--app-line);
  background: var(--app-raised);
  color: var(--app-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
  line-height: 1;
  transition: background 0.12s ease, color 0.12s ease;
}
.iconbtn:hover {
  background: var(--app-hover);
  color: var(--app-ink);
}
.iconbtn:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.iconbtn--sm {
  width: 26px;
  height: 26px;
  font-size: 13px;
}
.iconbtn--md {
  width: 32px;
  height: 32px;
  font-size: 15px;
}
</style>
