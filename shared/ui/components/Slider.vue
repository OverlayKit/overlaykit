<script setup lang="ts">
// Labeled range with a value readout (Redondez, Velocidad, Escalonado…). The
// readout text is caller-formatted (e.g. "14px", "320ms") so the control stays
// unit-agnostic. v-model compatible (modelValue is a number).
withDefaults(
  defineProps<{
    modelValue?: number;
    min?: number;
    max?: number;
    step?: number;
    label?: string;
    valueText?: string;
  }>(),
  { modelValue: 0, min: 0, max: 100, step: 1 }
);
defineEmits<{ (e: 'update:modelValue', v: number): void }>();
</script>

<template>
  <div class="slider">
    <div v-if="label || valueText" class="slider__head">
      <span v-if="label" class="slider__label">{{ label }}</span>
      <span v-if="valueText" class="slider__value">{{ valueText }}</span>
    </div>
    <input
      class="slider__range"
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="modelValue"
      @input="$emit('update:modelValue', Number(($event.target as HTMLInputElement).value))"
    />
  </div>
</template>

<style scoped>
.slider {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.slider__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.slider__label {
  font-size: var(--text-xs);
  color: var(--app-muted);
  font-weight: var(--weight-medium);
}
.slider__value {
  font-size: var(--text-xs);
  color: var(--app-ink);
  font-variant-numeric: tabular-nums;
}
.slider__range {
  width: 100%;
  accent-color: var(--control-fill);
}
.slider__range:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  border-radius: var(--radius-sm);
}
</style>
