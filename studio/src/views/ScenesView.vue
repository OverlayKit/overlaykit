<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ArrowUpRight, Layers3, Pencil, Plus } from '@lucide/vue';
import { api, type Show } from '../api';

interface SceneMeta { id: string; name: string; channelId: string; elementCount: number; updatedAt: number }
const props = defineProps<{ show: Show }>();
const router = useRouter();
const scenes = ref<SceneMeta[]>([]);
const loading = ref(true);
const creating = ref(false);
const error = ref('');

onMounted(async () => {
  const result = await api<{ collections: SceneMeta[] }>(`/api/collections?channelId=${encodeURIComponent(props.show.id)}`);
  scenes.value = result.collections;
  loading.value = false;
});

// AC-006: choosing New Scene creates a new independent Scene in this Show and opens it in the Editor.
async function createScene(): Promise<void> {
  if (creating.value) return;
  creating.value = true;
  error.value = '';
  try {
    const name = `Scene ${scenes.value.length + 1}`;
    const created = await api<{ id: string }>(`/api/shows/${encodeURIComponent(props.show.id)}/scenes`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    await router.push(`/shows/${props.show.id}/scenes/${created.id}/edit`);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Could not create scene';
    creating.value = false;
  }
}
</script>

<template>
  <div class="page show-page">
    <header class="page-header"><div><span class="eyebrow">{{ show.name.toUpperCase() }}</span><h1>Scenes</h1><p>Compose the visual states used during this production.</p></div><button class="primary-button" type="button" :disabled="creating" @click="createScene"><Plus :size="17" />New scene</button></header>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <div v-if="loading" class="empty-state">Loading scenes...</div>
    <div v-else-if="scenes.length" class="scene-grid">
      <article v-for="scene in scenes" :key="scene.id" class="scene-card">
        <div class="scene-preview"><Layers3 :size="32" /><span>{{ scene.elementCount }} elements</span></div>
        <div class="scene-card-copy"><strong>{{ scene.name }}</strong><small>Edited {{ new Date(scene.updatedAt).toLocaleDateString() }}</small></div>
        <RouterLink class="open-button" :to="`/shows/${show.id}/scenes/${scene.id}/edit`"><Pencil :size="15" />Edit<ArrowUpRight :size="15" /></RouterLink>
      </article>
    </div>
    <div v-else class="empty-state"><Layers3 :size="28" /><h2>No scenes yet</h2><p>Open the editor and compose the first visual state.</p><button class="primary-button" type="button" :disabled="creating" @click="createScene"><Plus :size="17" />New scene</button></div>
  </div>
</template>
