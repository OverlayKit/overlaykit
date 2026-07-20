<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ArrowRight, Check, Layers3, Radio, RefreshCw } from '@lucide/vue';
import { api, type ProductionState, type Show } from '../api';
import { canTake, productionMonitorUrl } from '../production';

interface SceneMeta {
  id: string;
  name: string;
  elementCount: number;
  updatedAt: number;
}

const props = defineProps<{ show: Show }>();
const state = ref<ProductionState | null>(null);
const scenes = ref<SceneMeta[]>([]);
const loadingSceneId = ref('');
const taking = ref(false);
const error = ref('');
let refreshTimer: ReturnType<typeof window.setInterval> | undefined;

const previewUrl = computed(() => productionMonitorUrl(props.show.id, 'preview'));
const programUrl = computed(() => productionMonitorUrl(props.show.id, 'program'));
const takeEnabled = computed(() => canTake(state.value) && !taking.value);

async function refresh(): Promise<void> {
  state.value = await api<ProductionState>(`/api/shows/${encodeURIComponent(props.show.id)}/production`);
}

async function loadScenes(): Promise<void> {
  const result = await api<{ collections: SceneMeta[] }>(`/api/collections?channelId=${encodeURIComponent(props.show.id)}`);
  scenes.value = result.collections;
}

async function loadPreview(scene: SceneMeta): Promise<void> {
  loadingSceneId.value = scene.id;
  error.value = '';
  try {
    state.value = await api<ProductionState>(
      `/api/shows/${encodeURIComponent(props.show.id)}/production/preview/scenes/${encodeURIComponent(scene.id)}`,
      { method: 'POST' },
    );
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Unable to load Preview';
  } finally {
    loadingSceneId.value = '';
  }
}

async function take(): Promise<void> {
  if (!state.value || !takeEnabled.value) return;
  taking.value = true;
  error.value = '';
  try {
    state.value = await api<ProductionState>(
      `/api/shows/${encodeURIComponent(props.show.id)}/production/take`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedPreviewRevision: state.value.preview.revision,
          operationId: crypto.randomUUID(),
        }),
      },
    );
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Take failed';
    await refresh();
  } finally {
    taking.value = false;
  }
}

onMounted(async () => {
  await Promise.all([refresh(), loadScenes()]);
  refreshTimer = window.setInterval(() => { void refresh(); }, 2500);
});

onUnmounted(() => {
  if (refreshTimer) window.clearInterval(refreshTimer);
});
</script>

<template>
  <div class="production-page">
    <div class="section-heading">
      <div><span class="eyebrow">CONTROL ROOM</span><h1>Production</h1></div>
      <span class="live-indicator"><i />{{ state?.program.scene?.name || 'Program clear' }}</span>
    </div>

    <div class="production-console">
      <aside class="scene-rundown" aria-label="Scene rundown">
        <header><div><span>Rundown</span><small>{{ scenes.length }} scenes</small></div><RouterLink class="icon-button" :to="`/shows/${show.id}/scenes`" title="Manage scenes"><Layers3 :size="16" /></RouterLink></header>
        <div v-if="scenes.length" class="rundown-list">
          <button
            v-for="(scene, index) in scenes"
            :key="scene.id"
            class="rundown-item"
            :class="{ loaded: state?.preview.scene?.id === scene.id }"
            type="button"
            :disabled="Boolean(loadingSceneId)"
            @click="loadPreview(scene)"
          >
            <span class="rundown-index">{{ String(index + 1).padStart(2, '0') }}</span>
            <span class="rundown-copy"><strong>{{ scene.name }}</strong><small>{{ scene.elementCount }} elements</small></span>
            <RefreshCw v-if="loadingSceneId === scene.id" class="spin" :size="15" />
            <Check v-else-if="state?.preview.scene?.id === scene.id" :size="15" />
            <ArrowRight v-else :size="15" />
          </button>
        </div>
        <div v-else class="rundown-empty"><Layers3 :size="24" /><span>No saved scenes</span><RouterLink class="secondary-button" :to="`/shows/${show.id}/new-scene`">Create scene</RouterLink></div>
      </aside>

      <section class="production-switcher">
        <div class="monitor-grid">
          <article class="production-monitor preview-monitor">
            <header><div><span>Preview</span><small>{{ state?.preview.scene?.name || 'No scene loaded' }}</small></div><b>REV {{ state?.preview.revision ?? 0 }}</b></header>
            <div class="monitor-canvas"><iframe :src="previewUrl" title="Preview monitor" /></div>
          </article>
          <article class="production-monitor program-monitor">
            <header><div><span>Program</span><small>{{ state?.program.scene?.name || 'Clear output' }}</small></div><b>REV {{ state?.program.revision ?? 0 }}</b></header>
            <div class="monitor-canvas"><iframe :src="programUrl" title="Program monitor" /></div>
          </article>
        </div>

        <div class="take-bar">
          <div class="take-copy">
            <Radio :size="17" />
            <span v-if="state?.lastTake">Last Take: Preview {{ state.lastTake.previewRevision }} to Program {{ state.lastTake.programRevision }}</span>
            <span v-else>Load a Scene into Preview, inspect it, then Take.</span>
          </div>
          <p v-if="error" class="form-error">{{ error }}</p>
          <button class="take-button" type="button" :disabled="!takeEnabled" @click="take">
            <ArrowRight :size="18" />{{ taking ? 'Taking...' : 'Take' }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
