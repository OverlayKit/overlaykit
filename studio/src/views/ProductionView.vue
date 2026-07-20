<script setup lang="ts">
import { computed, ref } from 'vue';
import { ExternalLink, Maximize2, Radio } from '@lucide/vue';
import type { Show } from '../api';

const props = defineProps<{ show: Show }>();
const expanded = ref<'output' | 'controls' | null>(null);
const overlayUrl = computed(() => `http://localhost:5183/production?channel=${encodeURIComponent(props.show.id)}&transparent=true&hideWatermark=true&readOnly=true`);
const panelUrl = computed(() => `http://localhost:5181/?channel=${encodeURIComponent(props.show.id)}&embedded=true`);
</script>

<template>
  <div class="production-page">
    <div class="section-heading"><div><span class="eyebrow">CONTROL ROOM</span><h1>Production</h1></div><span class="live-indicator"><i />Current program</span></div>
    <div class="production-grid" :class="expanded ? `is-${expanded}` : ''">
      <section class="tool-frame output-frame">
        <header><div><span>Program output</span><small>1920 × 1080</small></div><div class="frame-actions"><a class="icon-button" :href="overlayUrl" target="_blank" title="Open output"><ExternalLink :size="16" /></a><button class="icon-button" title="Expand output" @click="expanded = expanded === 'output' ? null : 'output'"><Maximize2 :size="16" /></button></div></header>
        <div class="output-canvas"><iframe :src="overlayUrl" title="Program output" /></div>
      </section>
      <section class="tool-frame controls-frame">
        <header><div><span>Live controls</span><small>{{ show.name }}</small></div><button class="icon-button" title="Expand controls" @click="expanded = expanded === 'controls' ? null : 'controls'"><Maximize2 :size="16" /></button></header>
        <iframe :src="panelUrl" title="Live controls" />
      </section>
    </div>
    <footer class="production-status"><Radio :size="15" /><span>Changes made in Live controls affect Program immediately in this transitional runtime.</span></footer>
  </div>
</template>
