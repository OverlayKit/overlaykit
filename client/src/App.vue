<template>
  <router-view />
</template>

<script setup lang="ts">
// Routing-only shell. The "/" → "/production" redirect (preserving the incoming
// channel / t / transparent query) lives in the router config. A prior onMounted
// redirect here RACED the initial navigation — it saw the start location ("/")
// before /production?...&t= resolved and clobbered it with default params,
// Keep the production route query parameters intact.
</script>

<style scoped>
</style>
