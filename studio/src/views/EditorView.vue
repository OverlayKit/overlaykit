<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { ExternalLink } from '@lucide/vue';
import type { Show } from '../api';

const props = defineProps<{ show: Show }>();
const route = useRoute();
const editorUrl = computed(() => {
  const query = new URLSearchParams({ channel: props.show.id, show: props.show.id, embedded: 'true' });
  if (route.params.sceneId) query.set('collection', String(route.params.sceneId));
  return `http://localhost:5174/?${query.toString()}`;
});
</script>

<template>
  <div class="embedded-editor">
    <header><div><span class="eyebrow">SCENE EDITOR</span><strong>{{ route.params.sceneId ? 'Edit scene' : 'New scene' }}</strong></div><a class="open-button" :href="editorUrl" target="_blank">Open separately<ExternalLink :size="15" /></a></header>
    <iframe :src="editorUrl" title="Scene editor" />
  </div>
</template>
