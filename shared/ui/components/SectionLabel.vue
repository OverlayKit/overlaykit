<script setup lang="ts">
// Uppercase cyan micro-label that heads a rail/card section. Optional `hint`
// (plain helper line) and a `right` slot for a trailing badge/count.
defineProps<{ hint?: string }>();
</script>

<template>
  <div class="seclabel">
    <div class="seclabel__row">
      <span class="seclabel__title"><slot /></span>
      <span v-if="$slots.right" class="seclabel__right"><slot name="right" /></span>
    </div>
    <div v-if="hint" class="seclabel__hint">{{ hint }}</div>
  </div>
</template>

<style scoped>
.seclabel__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.seclabel__title {
  font-size: var(--text-label);
  letter-spacing: var(--tracking-label);
  text-transform: uppercase;
  color: var(--app-accent);
  font-weight: var(--weight-semibold);
}
.seclabel__hint {
  font-size: var(--text-xs);
  color: var(--app-faint);
  margin-top: 4px;
  line-height: var(--leading-snug);
}
.seclabel__right {
  display: inline-flex;
  align-items: center;
}
</style>
