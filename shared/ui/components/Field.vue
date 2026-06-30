<script setup lang="ts">
// Labeled control wrapper. Slot holds the input/select/control.
defineProps<{ label?: string }>();
</script>

<template>
  <label class="field">
    <span v-if="label" class="field__label">{{ label }}</span>
    <slot />
  </label>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field__label {
  font-size: var(--text-xs);
  color: var(--app-muted);
  font-weight: var(--weight-medium);
}
</style>
