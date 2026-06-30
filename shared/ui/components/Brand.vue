<script setup lang="ts">
// Brand mark — ◆ diamond glyph (gradient) + wordmark. Authentic to OverlayKit.
withDefaults(defineProps<{ size?: number; label?: string }>(), {
  size: 18,
  label: 'OverlayKit',
});
</script>

<template>
  <div class="brand">
    <span class="brand__mark" :style="{ fontSize: size + 'px' }">◆</span>
    <strong
      v-if="label"
      class="brand__word"
      :style="{ fontSize: Math.round(size * 0.82) + 'px' }"
      >{{ label }}</strong
    >
  </div>
</template>

<style scoped>
.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.brand__mark {
  line-height: 1;
  background: var(--grad-brand);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.brand__word {
  letter-spacing: -0.01em;
  white-space: nowrap;
  color: var(--app-ink);
}
</style>
