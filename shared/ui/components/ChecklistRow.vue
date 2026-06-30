<script setup lang="ts">
// One setup step: done (green check) or pending. Reassuring, explicit state.
withDefaults(
  defineProps<{
    done?: boolean;
    label?: string;
    hint?: string;
    pendingLabel?: string;
  }>(),
  { done: false, pendingLabel: 'Pendiente' }
);
</script>

<template>
  <div class="crow" :class="{ 'is-done': done }">
    <span class="crow__check" aria-hidden="true">{{ done ? '✓' : '' }}</span>
    <div class="crow__text">
      <div class="crow__label">{{ label }}</div>
      <div v-if="hint" class="crow__hint">{{ hint }}</div>
    </div>
    <span class="crow__state">{{ done ? 'Listo' : pendingLabel }}</span>
  </div>
</template>

<style scoped>
.crow {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--app-raised);
  border: 1px solid var(--app-line);
  border-radius: var(--radius-md);
}
.crow__check {
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
  border-radius: var(--radius-pill);
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: var(--weight-bold);
  color: var(--app-faint);
  border: 1.5px solid var(--app-line-strong);
}
.crow.is-done .crow__check {
  color: var(--app-on-accent);
  background: var(--state-published);
  border-color: var(--state-published);
}
.crow__text {
  flex: 1;
  min-width: 0;
}
.crow__label {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--app-ink);
}
.crow__hint {
  font-size: var(--text-xs);
  color: var(--app-muted);
  margin-top: 2px;
}
.crow__state {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
  color: var(--app-faint);
}
.crow.is-done .crow__state {
  color: var(--state-published);
}
</style>
