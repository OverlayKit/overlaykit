<script setup lang="ts">
// Inset dark text well with a cyan focus ring. v-model compatible.
withDefaults(
  defineProps<{
    modelValue?: string | number;
    readonly?: boolean;
    placeholder?: string;
    type?: string;
  }>(),
  { type: 'text', readonly: false }
);
defineEmits<{ (e: 'update:modelValue', v: string): void }>();
</script>

<template>
  <input
    class="input"
    :value="modelValue"
    :readonly="readonly"
    :placeholder="placeholder"
    :type="type"
    @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>

<style scoped>
.input {
  width: 100%;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
  color: var(--app-ink);
  padding: 10px 12px;
  font-size: var(--text-sm);
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.input::placeholder {
  color: var(--app-faint);
}
.input:focus {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: var(--glow-accent);
}
.input:read-only {
  color: var(--app-muted);
}
</style>
