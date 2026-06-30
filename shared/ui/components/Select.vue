<script setup lang="ts">
// Native select with a calm custom chevron. Options accept plain strings or
// { value, label }. v-model compatible; also emits `change`.
withDefaults(
  defineProps<{
    modelValue?: string;
    options?: (string | { value: string; label: string })[];
  }>(),
  { options: () => [] }
);
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'change', v: string): void;
}>();

function norm(o: string | { value: string; label: string }) {
  return typeof o === 'string' ? { value: o, label: o } : o;
}
function onChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  emit('update:modelValue', v);
  emit('change', v);
}
</script>

<template>
  <div class="select">
    <select class="select__el" :value="modelValue" @change="onChange">
      <option v-for="o in options.map(norm)" :key="o.value" :value="o.value">
        {{ o.label }}
      </option>
    </select>
    <span class="select__chevron" aria-hidden="true">▾</span>
  </div>
</template>

<style scoped>
.select {
  position: relative;
  display: block;
}
.select__el {
  appearance: none;
  width: 100%;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
  color: var(--app-ink);
  padding: 9px 30px 9px 12px;
  font-size: var(--text-sm);
  cursor: pointer;
}
.select__el:focus {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: var(--glow-accent);
}
.select__chevron {
  position: absolute;
  right: 11px;
  top: 50%;
  transform: translateY(-50%);
  pointer-events: none;
  color: var(--app-muted);
  font-size: 11px;
}
</style>
