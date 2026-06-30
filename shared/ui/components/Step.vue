<script setup lang="ts">
// Numbered step with a gradient bullet (OBS setup, guided flows).
defineProps<{ n?: string | number; title?: string }>();
</script>

<template>
  <div class="step">
    <span class="step__n">{{ n }}</span>
    <div class="step__body">
      <div class="step__title">{{ title }}</div>
      <div class="step__content"><slot /></div>
    </div>
  </div>
</template>

<style scoped>
.step {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}
.step__n {
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border-radius: var(--radius-pill);
  display: grid;
  place-items: center;
  background: var(--grad-brand);
  color: #fff;
  font-weight: var(--weight-bold);
  font-size: var(--text-sm);
}
.step__body {
  flex: 1;
  min-width: 0;
}
.step__title {
  font-size: var(--text-body);
  font-weight: var(--weight-semibold);
  margin-bottom: 6px;
}
.step__content {
  color: var(--app-muted);
}
</style>
