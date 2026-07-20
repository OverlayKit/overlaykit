<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { MonitorPlay, PanelsTopLeft, ShieldCheck } from '@lucide/vue';
import { api, type Show } from '../api';

const route = useRoute();
const show = ref<Show | null>(null);

async function loadShow(): Promise<void> {
  show.value = await api<Show>(`/api/shows/${encodeURIComponent(String(route.params.showId))}`);
}

onMounted(loadShow);
watch(() => route.params.showId, loadShow);
</script>

<template>
  <div v-if="show" class="show-workspace">
    <header class="show-header">
      <div><RouterLink class="breadcrumb" to="/shows">Shows</RouterLink><span>/</span><strong>{{ show.name }}</strong></div>
      <nav class="show-nav" aria-label="Show workspace">
        <RouterLink :to="`/shows/${show.id}/production`"><MonitorPlay :size="16" />Production</RouterLink>
        <RouterLink :to="`/shows/${show.id}/scenes`"><PanelsTopLeft :size="16" />Scenes</RouterLink>
        <RouterLink :to="`/shows/${show.id}/security`"><ShieldCheck :size="16" />Output</RouterLink>
      </nav>
    </header>
    <RouterView :show="show" />
  </div>
  <div v-else class="empty-state">Loading show...</div>
</template>
