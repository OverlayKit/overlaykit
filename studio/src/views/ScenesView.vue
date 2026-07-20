<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ArrowUpRight, Layers3, Pencil, Plus } from '@lucide/vue';
import { api, type Show } from '../api';

interface SceneMeta { id: string; name: string; channelId: string; elementCount: number; updatedAt: number }
const props = defineProps<{ show: Show }>();
const scenes = ref<SceneMeta[]>([]);
const loading = ref(true);

onMounted(async () => {
  const result = await api<{ collections: SceneMeta[] }>(`/api/collections?channelId=${encodeURIComponent(props.show.id)}`);
  scenes.value = result.collections;
  loading.value = false;
});
</script>

<template>
  <div class="page show-page">
    <header class="page-header"><div><span class="eyebrow">{{ show.name.toUpperCase() }}</span><h1>Scenes</h1><p>Compose the visual states used during this production.</p></div><RouterLink class="primary-button" :to="`/shows/${show.id}/new-scene`"><Plus :size="17" />New scene</RouterLink></header>
    <div v-if="loading" class="empty-state">Loading scenes...</div>
    <div v-else-if="scenes.length" class="scene-grid">
      <article v-for="scene in scenes" :key="scene.id" class="scene-card">
        <div class="scene-preview"><Layers3 :size="32" /><span>{{ scene.elementCount }} elements</span></div>
        <div class="scene-card-copy"><strong>{{ scene.name }}</strong><small>Edited {{ new Date(scene.updatedAt).toLocaleDateString() }}</small></div>
        <RouterLink class="open-button" :to="`/shows/${show.id}/scenes/${scene.id}/edit`"><Pencil :size="15" />Edit<ArrowUpRight :size="15" /></RouterLink>
      </article>
    </div>
    <div v-else class="empty-state"><Layers3 :size="28" /><h2>No scenes yet</h2><p>Open the editor and compose the first visual state.</p><RouterLink class="primary-button" :to="`/shows/${show.id}/new-scene`"><Plus :size="17" />New scene</RouterLink></div>
  </div>
</template>
