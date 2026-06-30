<script setup lang="ts">
// Vertical stack of ChecklistRow items (quickstart setup list).
</script>

<template>
  <div class="checklist"><slot /></div>
</template>

<style scoped>
.checklist {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
