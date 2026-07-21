<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import type { ControlValue, ProductionControl } from '@overlaykit/protocol';
import Button from './Button.vue';
import Select from './Select.vue';
import Toggle from './Toggle.vue';

const props = withDefaults(defineProps<{
  controls: ProductionControl[];
  busy?: boolean;
  disabled?: boolean;
  error?: string;
}>(), {
  busy: false,
  disabled: false,
  error: '',
});

const emit = defineEmits<{
  (event: 'apply', values: Record<string, ControlValue>): void;
}>();

const published = reactive<Record<string, ControlValue>>({});
const draft = reactive<Record<string, ControlValue>>({});

function same(left: ControlValue | undefined, right: ControlValue | undefined): boolean {
  return left === right;
}

watch(
  () => props.controls,
  (controls) => {
    const active = new Set(controls.map((control) => control.id));
    for (const control of controls) {
      const wasClean = !(control.id in draft) || same(draft[control.id], published[control.id]);
      published[control.id] = control.value;
      if (wasClean) draft[control.id] = control.value;
    }
    for (const id of Object.keys(published)) {
      if (!active.has(id)) {
        delete published[id];
        delete draft[id];
      }
    }
  },
  { immediate: true, deep: true },
);

const groups = computed(() => {
  const grouped = new Map<string, { id: string; label: string; controls: ProductionControl[] }>();
  for (const control of props.controls) {
    const current = grouped.get(control.componentId) ?? {
      id: control.componentId,
      label: control.componentLabel,
      controls: [],
    };
    current.controls.push(control);
    grouped.set(control.componentId, current);
  }
  return [...grouped.values()];
});

const dirtyValues = computed<Record<string, ControlValue>>(() => {
  const values: Record<string, ControlValue> = {};
  for (const control of props.controls) {
    if (!same(draft[control.id], published[control.id])) values[control.id] = draft[control.id];
  }
  return values;
});

const dirtyCount = computed(() => Object.keys(dirtyValues.value).length);

function setValue(control: ProductionControl, raw: string | boolean): void {
  if (control.type === 'number') {
    const value = Number(raw);
    if (Number.isFinite(value)) draft[control.id] = value;
    return;
  }
  draft[control.id] = raw;
}

function discard(): void {
  for (const control of props.controls) draft[control.id] = published[control.id];
}

function apply(): void {
  if (dirtyCount.value === 0 || props.busy || props.disabled) return;
  emit('apply', { ...dirtyValues.value });
}
</script>

<template>
  <section class="operator-controls" aria-labelledby="operator-controls-title">
    <header class="operator-controls__header">
      <div>
        <span class="operator-controls__eyebrow">PREVIEW</span>
        <h2 id="operator-controls-title">Component controls</h2>
      </div>
      <span class="operator-controls__count">{{ controls.length }} declared</span>
    </header>

    <div v-if="controls.length" class="operator-controls__groups">
      <section v-for="group in groups" :key="group.id" class="operator-group">
        <h3>{{ group.label }}</h3>
        <div class="operator-group__grid">
          <label v-for="control in group.controls" :key="control.id" class="operator-field">
            <span class="operator-field__label">{{ control.label }}</span>
            <span v-if="control.description" class="operator-field__description">{{ control.description }}</span>

            <Toggle
              v-if="control.type === 'toggle'"
              :model-value="Boolean(draft[control.id])"
              :disabled="disabled || busy"
              @update:model-value="setValue(control, $event)"
            />
            <Select
              v-else-if="control.type === 'select'"
              :model-value="String(draft[control.id] ?? '')"
              :options="control.options || []"
              @update:model-value="setValue(control, $event)"
            />
            <input
              v-else-if="control.type === 'number'"
              type="number"
              :value="draft[control.id]"
              :min="control.min"
              :max="control.max"
              :step="control.step || 'any'"
              :disabled="disabled || busy"
              @input="setValue(control, ($event.target as HTMLInputElement).value)"
            />
            <div v-else-if="control.type === 'color'" class="operator-field__color">
              <input
                type="color"
                :value="String(draft[control.id])"
                :disabled="disabled || busy"
                @input="setValue(control, ($event.target as HTMLInputElement).value)"
              />
              <input
                type="text"
                :value="draft[control.id]"
                pattern="^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?$"
                :disabled="disabled || busy"
                @input="setValue(control, ($event.target as HTMLInputElement).value)"
              />
            </div>
            <input
              v-else
              type="text"
              :value="draft[control.id]"
              :disabled="disabled || busy"
              @input="setValue(control, ($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>
      </section>
    </div>

    <div v-else class="operator-controls__empty">
      This Preview has no declared controls. Add controls to a component in Editor.
    </div>

    <p v-if="error" class="operator-controls__error" role="alert">{{ error }}</p>
    <footer v-if="controls.length" class="operator-controls__footer">
      <span>{{ dirtyCount ? `${dirtyCount} pending` : 'Preview values are current' }}</span>
      <div>
        <Button size="sm" variant="ghost" :disabled="!dirtyCount || busy" @click="discard">Discard</Button>
        <Button size="sm" variant="primary" :disabled="!dirtyCount || busy || disabled" @click="apply">
          {{ busy ? 'Applying...' : 'Apply to Preview' }}
        </Button>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.operator-controls { min-width: 0; color: var(--app-ink); }
.operator-controls__header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.operator-controls__header h2 { margin: 2px 0 0; font-size: 16px; letter-spacing: 0; }
.operator-controls__eyebrow { color: var(--app-accent); font-size: 10px; font-weight: 800; letter-spacing: 0; }
.operator-controls__count { color: var(--app-muted); font-size: 12px; }
.operator-controls__groups { display: grid; gap: 16px; }
.operator-group { min-width: 0; border-top: 1px solid var(--app-line); padding-top: 12px; }
.operator-group h3 { margin: 0 0 10px; color: var(--app-muted); font-size: 12px; font-weight: 700; letter-spacing: 0; }
.operator-group__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.operator-field { display: flex; min-width: 0; flex-direction: column; gap: 6px; }
.operator-field__label { font-size: 12px; font-weight: 700; }
.operator-field__description { color: var(--app-muted); font-size: 11px; line-height: 1.4; }
.operator-field > input,
.operator-field__color input[type='text'] { width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid var(--input-border); border-radius: var(--radius-sm); background: var(--input-bg); color: var(--app-ink); padding: 9px 10px; font: inherit; font-size: 13px; }
.operator-field input:focus { outline: none; border-color: var(--border-focus); box-shadow: var(--focus-ring); }
.operator-field__color { display: grid; grid-template-columns: 38px minmax(0, 1fr); gap: 8px; }
.operator-field__color input[type='color'] { width: 38px; height: 38px; border: 1px solid var(--input-border); border-radius: var(--radius-sm); background: var(--input-bg); padding: 3px; }
.operator-controls__empty { border-top: 1px solid var(--app-line); color: var(--app-muted); padding: 18px 0; font-size: 13px; line-height: 1.5; }
.operator-controls__error { margin: 12px 0 0; color: var(--state-danger); font-size: 12px; }
.operator-controls__footer { display: flex; align-items: center; justify-content: space-between; gap: 14px; border-top: 1px solid var(--app-line); margin-top: 16px; padding-top: 12px; color: var(--app-muted); font-size: 12px; }
.operator-controls__footer > div { display: flex; gap: 8px; }
@media (max-width: 560px) {
  .operator-controls__header,
  .operator-controls__footer { align-items: flex-start; flex-direction: column; }
  .operator-controls__footer > div { width: 100%; }
  .operator-controls__footer > div :deep(button) { flex: 1; }
}
</style>
