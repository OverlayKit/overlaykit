<script setup lang="ts">
// Pill switch — cyan when on. v-model compatible (modelValue boolean).
withDefaults(
  defineProps<{ modelValue?: boolean; label?: string; disabled?: boolean }>(),
  { modelValue: false, disabled: false }
);
defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();
</script>

<template>
  <label class="toggle" :class="{ 'is-on': modelValue, 'is-disabled': disabled }">
    <button
      type="button"
      class="toggle__track"
      role="switch"
      :aria-checked="modelValue"
      :disabled="disabled"
      @click="$emit('update:modelValue', !modelValue)"
    >
      <span class="toggle__thumb" />
    </button>
    <span v-if="label" class="toggle__label">{{ label }}</span>
  </label>
</template>

<style scoped>
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}
.toggle.is-disabled {
  opacity: 0.5;
  pointer-events: none;
}
.toggle__track {
  width: 38px;
  height: 22px;
  border-radius: var(--radius-pill);
  background: var(--control-track);
  border: 1px solid var(--app-line);
  position: relative;
  cursor: pointer;
  padding: 0;
  transition: background 0.14s ease, border-color 0.14s ease;
}
.toggle.is-on .toggle__track {
  background: var(--cyan-400);
  border-color: var(--cyan-400);
}
.toggle__thumb {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-pill);
  background: var(--control-thumb);
  box-shadow: var(--shadow-sm);
  transition: transform 0.14s ease;
}
.toggle.is-on .toggle__thumb {
  transform: translateX(16px);
}
.toggle__track:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.toggle__label {
  font-size: var(--text-sm);
  color: var(--app-ink);
}
@media (prefers-reduced-motion: reduce) {
  .toggle__track,
  .toggle__thumb {
    transition: none;
  }
}
</style>
