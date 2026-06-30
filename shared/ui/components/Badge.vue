<script setup lang="ts">
// State-coded pill. Tones map to the sacred live-production state colors.
// State never relies on color alone — pass `dot` for a leading indicator.
withDefaults(
  defineProps<{
    tone?: 'live' | 'draft' | 'published' | 'accent' | 'neutral' | 'danger';
    dot?: boolean;
    size?: 'sm' | 'md';
  }>(),
  { tone: 'neutral', dot: false, size: 'md' }
);
</script>

<template>
  <span class="badge" :class="[`badge--${tone}`, `badge--${size}`]">
    <span v-if="dot" class="badge__dot" />
    <slot />
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius-pill);
  font-weight: var(--weight-semibold);
  border: 1px solid transparent;
  white-space: nowrap;
}
.badge--sm {
  font-size: 10.5px;
  padding: 2px 8px;
}
.badge--md {
  font-size: var(--text-xs);
  padding: 3px 10px;
}
.badge__dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: currentColor;
  flex: 0 0 auto;
}
.badge--live {
  color: var(--state-live);
  background: var(--tint-live);
  border-color: rgba(239, 68, 68, 0.35);
}
.badge--draft {
  color: var(--amber-300);
  background: var(--tint-draft);
  border-color: rgba(245, 158, 11, 0.35);
}
.badge--published {
  color: var(--state-published);
  background: var(--tint-published);
  border-color: rgba(34, 197, 94, 0.35);
}
.badge--accent {
  color: var(--cyan-300);
  background: var(--app-accent-quiet);
  border-color: var(--app-accent-line);
}
.badge--neutral {
  color: var(--app-muted);
  background: var(--app-raised);
  border-color: var(--app-line);
}
.badge--danger {
  color: #fca5a5;
  background: var(--tint-danger);
  border-color: rgba(220, 38, 38, 0.4);
}
</style>
