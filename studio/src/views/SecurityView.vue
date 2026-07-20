<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Check, Clipboard, KeyRound, RotateCw, ShieldCheck } from '@lucide/vue';
import { api, type Show } from '../api';
import { auth } from '../auth';

const props = defineProps<{ show?: Show }>();
const shows = ref<Show[]>([]);
const selectedShowId = ref(props.show?.id || '');
const outputToken = ref('');
const copied = ref(false);
const rotating = ref(false);
const outputUrl = computed(() => outputToken.value && selectedShowId.value
  ? `http://localhost:5183/production?channel=${encodeURIComponent(selectedShowId.value)}&transparent=true&token=${encodeURIComponent(outputToken.value)}`
  : '');

onMounted(async () => {
  shows.value = await api<Show[]>('/api/shows');
  if (!selectedShowId.value) selectedShowId.value = shows.value[0]?.id || '';
});

async function rotateToken(): Promise<void> {
  rotating.value = true;
  try {
    const result = await api<{ token: string; updatedAt: string }>('/api/auth/output-token', { method: 'POST' });
    outputToken.value = result.token;
    if (auth.state.output) Object.assign(auth.state.output, { configured: true, updatedAt: result.updatedAt });
  } finally {
    rotating.value = false;
  }
}

async function copyUrl(): Promise<void> {
  await navigator.clipboard.writeText(outputUrl.value);
  copied.value = true;
  window.setTimeout(() => { copied.value = false; }, 1600);
}
</script>

<template>
  <div class="page settings-page">
    <header class="page-header"><div><span class="eyebrow">INSTANCE SECURITY</span><h1>Output access</h1><p>Issue the read-only credential used by OBS browser sources.</p></div><span class="security-state"><ShieldCheck :size="18" />Protected</span></header>

    <section class="settings-section">
      <div class="settings-copy"><KeyRound :size="20" /><div><strong>OBS output token</strong><p>Rotating invalidates the previous browser source URL immediately.</p></div></div>
      <div class="token-status"><span :class="{ configured: auth.state.output?.configured }" /><span>{{ auth.state.output?.configured ? 'Configured' : 'Not configured' }}</span><small v-if="auth.state.output?.updatedAt">{{ new Date(auth.state.output.updatedAt).toLocaleString() }}</small></div>
      <button class="secondary-button" type="button" :disabled="rotating" @click="rotateToken"><RotateCw :size="16" />{{ rotating ? 'Rotating...' : 'Rotate token' }}</button>
    </section>

    <section v-if="outputToken" class="token-reveal">
      <header><div><strong>New browser source</strong><p>This URL is shown once. Add it to OBS before leaving this page.</p></div><span>ONE-TIME VIEW</span></header>
      <label><span>Show</span><select v-model="selectedShowId"><option v-for="item in shows" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <div class="copy-field"><input :value="outputUrl" readonly /><button class="icon-button" type="button" :title="copied ? 'Copied' : 'Copy URL'" @click="copyUrl"><Check v-if="copied" :size="17" /><Clipboard v-else :size="17" /></button></div>
    </section>
  </div>
</template>
