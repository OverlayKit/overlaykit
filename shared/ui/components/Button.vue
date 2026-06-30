<script setup lang="ts">
// Primary action carries the signature purple→cyan gradient + brand glow.
// Secondary/ghost stay calm; danger is reserved for live-breaking actions.
withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    size?: 'sm' | 'md' | 'lg';
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
  }>(),
  { variant: 'secondary', size: 'md', disabled: false, type: 'button' }
);
</script>

<template>
  <button
    :type="type"
    :disabled="disabled"
    :class="['btn', `btn--${variant}`, `btn--${size}`]"
  >
    <span v-if="$slots.iconLeft" class="btn__icon"><slot name="iconLeft" /></span>
    <span class="btn__label"><slot /></span>
    <span v-if="$slots.iconRight" class="btn__icon"><slot name="iconRight" /></span>
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  font-family: var(--font-sans);
  font-weight: var(--weight-semibold);
  cursor: pointer;
  white-space: nowrap;
  transition: filter 0.12s ease, background 0.12s ease, transform 0.12s ease,
    box-shadow 0.12s ease;
}
.btn:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.btn:disabled {
  opacity: 0.5;
  pointer-events: none;
}
.btn--sm {
  padding: 6px 11px;
  font-size: var(--text-sm);
}
.btn--md {
  padding: 9px 14px;
  font-size: var(--text-body);
}
.btn--lg {
  padding: 12px 18px;
  font-size: var(--text-body-lg);
}
.btn--primary {
  background: var(--grad-brand);
  color: #fff;
  box-shadow: var(--glow-brand);
}
.btn--primary:hover {
  filter: brightness(1.08);
  transform: translateY(-1px);
}
.btn--primary:active {
  transform: none;
}
.btn--secondary {
  background: var(--app-raised);
  color: var(--app-ink);
  border-color: var(--app-line);
}
.btn--secondary:hover {
  background: var(--app-hover);
}
.btn--ghost {
  background: transparent;
  color: var(--app-muted);
}
.btn--ghost:hover {
  background: var(--app-raised);
  color: var(--app-ink);
}
.btn--danger {
  background: var(--state-danger);
  color: #fff;
}
.btn--danger:hover {
  filter: brightness(1.08);
}
.btn__icon {
  display: inline-flex;
  line-height: 1;
}
@media (prefers-reduced-motion: reduce) {
  .btn {
    transition: none;
  }
}
</style>
