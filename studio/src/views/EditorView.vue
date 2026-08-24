<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { ExternalLink } from '@lucide/vue';
import type { Show } from '../api';

const props = defineProps<{ show: Show }>();
const route = useRoute();
// Env-driven like every other cross-service URL in Studio (VITE_API_URL, VITE_OVERLAY_URL); the
// hardcoded localhost fallback preserves the default local dev experience.
const editorBaseUrl = (import.meta.env.VITE_EDITOR_URL || 'http://localhost:5174').replace(/\/$/, '');
const editorUrl = computed(() => {
  const query = new URLSearchParams({ channel: props.show.id, show: props.show.id, embedded: 'true' });
  if (route.params.sceneId) query.set('collection', String(route.params.sceneId));
  return `${editorBaseUrl}/?${query.toString()}`;
});
</script>

<template>
  <div class="embedded-editor">
    <header><div><span class="eyebrow">SCENE EDITOR</span><strong>{{ route.params.sceneId ? 'Edit scene' : 'New scene' }}</strong></div><a class="open-button" :href="editorUrl" target="_blank">Open separately<ExternalLink :size="15" /></a></header>
    <iframe :src="editorUrl" title="Scene editor" />
  </div>
</template>
