<script setup lang="ts">
// Labeled color control: a native swatch + a free-text value (so rgba()/
// gradients are still editable) + optional preset swatches. v-model on the
// string value. The swatch falls back to a sane hex when the value isn't a
// plain hex (rgba/gradient), without overwriting the text.
withDefaults(
  defineProps<{
    modelValue?: string;
    label?: string;
    swatches?: string[];
    placeholder?: string;
  }>(),
  { modelValue: '', swatches: () => [] }
);
defineEmits<{ (e: 'update:modelValue', v: string): void }>();

function toHex(v: string, fallback = '#000000'): string {
  return /^#([0-9a-fA-F]{3,8})$/.test((v || '').trim()) ? v.trim() : fallback;
}
</script>

<template>
  <label class="cc">
    <span v-if="label" class="cc__label">{{ label }}</span>
    <div class="cc__row">
      <input
        type="color"
        class="cc__swatch"
        :value="toHex(modelValue)"
        @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
      <input
        class="cc__text"
        :value="modelValue"
        :placeholder="placeholder"
        @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
    </div>
    <div v-if="swatches.length" class="cc__presets">
      <button
        v-for="s in swatches"
        :key="s"
        type="button"
        class="cc__preset"
        :style="{ background: s }"
        :title="s"
        @click="$emit('update:modelValue', s)"
      />
    </div>
  </label>
</template>

<style scoped>
.cc {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cc__label {
  font-size: var(--text-xs);
  color: var(--app-muted);
  font-weight: var(--weight-medium);
}
.cc__row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cc__swatch {
  width: 38px;
  height: 32px;
  flex: 0 0 auto;
  padding: 2px;
  cursor: pointer;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
}
.cc__text {
  flex: 1;
  min-width: 0;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
  color: var(--app-ink);
  padding: 8px 10px;
  font-size: var(--text-sm);
  font-family: var(--font-mono);
}
.cc__text:focus {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: var(--glow-accent);
}
.cc__presets {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.cc__preset {
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--app-line);
  cursor: pointer;
}
.cc__preset:hover {
  border-color: var(--app-accent);
}
.cc__preset:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
</style>
