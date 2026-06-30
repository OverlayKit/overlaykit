<!--
  SoundPicker: pick a sound clip from the server catalog instead of pasting a
  raw URL. Fetches GET {API}/api/sounds, lists clips grouped by category, lets
  the user preview (▶), pick one, and tweak volume/loop. Emits a Sound object
  ({ url, volume?, loop? }) so it drops into a sound.play action unchanged.
-->
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import type { Sound } from '@overlaykit/renderer/types/element';
import { soundCategoryLabel, SOUND_CATEGORY_ORDER } from '@overlaykit/renderer/utils/soundCategories';

const props = defineProps<{ modelValue: Sound | undefined }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: Sound): void }>();

const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3000';

interface SoundClip { id: string; name: string; category: string; url: string; durationMs?: number }

const clips = ref<SoundClip[]>([]);
const loading = ref(true);
const failed = ref(false);

// Resolve a catalog URL to something playable (catalog may store relative paths).
function absolute(url: string): string {
  return /^https?:\/\//.test(url) ? url : `${API}${url}`;
}

const grouped = computed(() => {
  const map = new Map<string, SoundClip[]>();
  for (const c of clips.value) {
    const cat = c.category || 'Otros';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(c);
  }
  const order = SOUND_CATEGORY_ORDER;
  const rank = (k: string) => { const i = order.indexOf(k); return i < 0 ? 99 : i; };
  return Array.from(map.entries())
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([category, items]) => ({ category, label: soundCategoryLabel(category), items }));
});

const selectedUrl = computed(() => props.modelValue?.url ?? '');
const volume = computed(() => props.modelValue?.volume ?? 0.5);
const loop = computed(() => props.modelValue?.loop ?? false);

const selectedName = computed(() => {
  const url = selectedUrl.value;
  if (!url) return '';
  const found = clips.value.find((c) => c.url === url || absolute(c.url) === url);
  return found?.name ?? url;
});

// A preview <audio> we reuse so previews don't stack up.
let preview: HTMLAudioElement | null = null;
function play(clip: SoundClip) {
  try {
    if (preview) preview.pause();
    preview = new Audio(absolute(clip.url));
    preview.volume = volume.value;
    void preview.play();
  } catch {
    /* preview is best-effort; ignore playback errors */
  }
}

function pick(clip: SoundClip) {
  emit('update:modelValue', { url: clip.url, volume: volume.value, loop: loop.value });
}
function setVolume(v: number) {
  emit('update:modelValue', { url: selectedUrl.value, volume: v, loop: loop.value });
}
function setLoop(v: boolean) {
  emit('update:modelValue', { url: selectedUrl.value, volume: volume.value, loop: v });
}

onMounted(async () => {
  try {
    const res = await fetch(`${API}/api/sounds`, { credentials: 'include' });
    if (!res.ok) throw new Error(String(res.status));
    const json = await res.json();
    clips.value = json?.data?.sounds ?? [];
  } catch {
    failed.value = true;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="sound-picker">
    <p v-if="loading" class="sp-muted">Cargando sonidos…</p>
    <p v-else-if="failed || !clips.length" class="sp-muted">No hay sonidos disponibles.</p>

    <template v-else>
      <div v-if="selectedUrl" class="sp-selected">
        <span class="sp-selected-label">Sonido:</span>
        <span class="sp-selected-name">{{ selectedName }}</span>
      </div>

      <div class="sp-list">
        <div v-for="g in grouped" :key="g.category" class="sp-group">
          <div class="sp-group-title">{{ g.label }}</div>
          <div
            v-for="clip in g.items"
            :key="clip.id"
            class="sp-clip"
            :class="{ active: clip.url === selectedUrl || absolute(clip.url) === selectedUrl }"
            @click="pick(clip)"
          >
            <button class="sp-play" title="Escuchar" @click.stop="play(clip)">▶</button>
            <span class="sp-clip-name">{{ clip.name }}</span>
          </div>
        </div>
      </div>

      <div class="sp-controls">
        <label class="sp-vol">
          Volumen
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            :value="volume"
            @input="setVolume(Number(($event.target as HTMLInputElement).value))"
          />
          <span class="sp-vol-num">{{ Math.round(volume * 100) }}%</span>
        </label>
        <label class="sp-loop">
          <input
            type="checkbox"
            :checked="loop"
            @change="setLoop(($event.target as HTMLInputElement).checked)"
          />
          Repetir
        </label>
      </div>
    </template>
  </div>
</template>

<style scoped>
.sound-picker { display: flex; flex-direction: column; gap: 8px; }
.sp-muted { color: var(--app-faint); font-size: 11px; margin: 0; text-transform: none; letter-spacing: 0; }
.sp-selected { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: #cfe2ff; }
.sp-selected-label { color: var(--app-accent); text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; }
.sp-selected-name { font-weight: 600; }
.sp-list {
  max-height: 168px; overflow-y: auto;
  border: 1px solid var(--app-line); border-radius: 6px; background: var(--surface-inset);
}
.sp-group-title {
  position: sticky; top: 0; background: var(--app-panel); color: var(--app-accent);
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
  padding: 4px 8px; border-bottom: 1px solid var(--app-line);
}
.sp-clip {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 8px; cursor: pointer; font-size: 12px; color: var(--app-ink);
  border-bottom: 1px solid var(--app-line);
}
.sp-clip:hover { background: var(--app-hover); }
.sp-clip.active { background: var(--app-selected-bg); border-left: 2px solid var(--app-selected-line); color: #fff; }
.sp-clip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp-play {
  background: var(--app-raised); border: 1px solid var(--app-line); color: var(--app-ink);
  border-radius: 4px; padding: 1px 7px; font-size: 11px; cursor: pointer; flex-shrink: 0;
}
.sp-play:hover { background: var(--app-hover); }
.sp-controls { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.sp-vol { display: flex; align-items: center; gap: 6px; color: var(--app-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
.sp-vol input[type='range'] { flex: 1; min-width: 90px; }
.sp-vol-num { color: var(--app-faint); font-size: 11px; min-width: 34px; }
.sp-loop { display: flex; align-items: center; gap: 6px; color: var(--app-ink); font-size: 12px; }
.sp-loop input { width: auto; }
</style>
