<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Archive, ArrowUpRight, Plus, Radio, X } from '@lucide/vue';
import { api, type Show } from '../api';

const shows = ref<Show[]>([]);
const loading = ref(true);
const creating = ref(false);
const name = ref('');
const description = ref('');
const error = ref('');

async function load(): Promise<void> {
  loading.value = true;
  try {
    shows.value = await api<Show[]>('/api/shows');
  } finally {
    loading.value = false;
  }
}

async function createShow(): Promise<void> {
  error.value = '';
  try {
    const show = await api<Show>('/api/shows', {
      method: 'POST',
      body: JSON.stringify({ name: name.value, description: description.value }),
    });
    shows.value.unshift(show);
    name.value = '';
    description.value = '';
    creating.value = false;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Could not create show';
  }
}

async function archiveShow(show: Show): Promise<void> {
  await api<Show>(`/api/shows/${encodeURIComponent(show.id)}`, { method: 'DELETE' });
  shows.value = shows.value.filter((item) => item.id !== show.id);
}

onMounted(load);
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div><span class="eyebrow">WORKSPACES</span><h1>Shows</h1><p>Each show contains its scenes, production controls, and output access.</p></div>
      <button class="primary-button" type="button" @click="creating = true"><Plus :size="17" />New show</button>
    </header>

    <section v-if="creating" class="inline-form" aria-label="Create show">
      <div class="inline-form-head"><strong>New show</strong><button class="icon-button" type="button" title="Close" @click="creating = false"><X :size="17" /></button></div>
      <div class="form-grid">
        <label><span>Name</span><input v-model="name" maxlength="100" autofocus placeholder="Friday Broadcast" /></label>
        <label><span>Description</span><input v-model="description" maxlength="500" placeholder="Weekly production" /></label>
      </div>
      <p v-if="error" class="form-error">{{ error }}</p>
      <button class="primary-button" type="button" :disabled="name.trim().length < 2" @click="createShow">Create show</button>
    </section>

    <div v-if="loading" class="empty-state">Loading shows...</div>
    <div v-else-if="shows.length" class="show-list">
      <article v-for="show in shows" :key="show.id" class="show-row">
        <span class="show-icon"><Radio :size="20" /></span>
        <div class="show-copy"><strong>{{ show.name }}</strong><span>{{ show.description || 'No description' }}</span></div>
        <time>{{ new Date(show.updatedAt).toLocaleDateString() }}</time>
        <button class="icon-button" type="button" title="Archive show" @click="archiveShow(show)"><Archive :size="17" /></button>
        <RouterLink class="open-button" :to="`/shows/${show.id}/production`">Open<ArrowUpRight :size="16" /></RouterLink>
      </article>
    </div>
    <div v-else class="empty-state"><Radio :size="28" /><h2>No shows yet</h2><p>Create the workspace for your first production.</p><button class="primary-button" @click="creating = true"><Plus :size="17" />New show</button></div>
  </div>
</template>
