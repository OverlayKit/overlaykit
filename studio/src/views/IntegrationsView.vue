<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Cable, KeyRound } from '@lucide/vue';
import { api, type Show } from '../api';

// The Show-scoped, secret-free projection the list endpoint returns (sealedSecret and the one-time
// token are never on the wire — see server/src/routes/deviceCredentials.ts).
interface DeviceCredentialSummary {
  credentialId: string;
  label: string;
  targets: string[];
  controlIds: string[];
  scopes: string[];
  generation: number;
  expiresAt: number;
  revokedAt: number | null;
}

const shows = ref<Show[]>([]);
const selectedShow = ref('');
const label = ref('Stream Deck');
const controlId = ref('visibility.toggle');
const scopeVisibility = ref(true);
const scopeFeedback = ref(true);
const issuing = ref(false);
const error = ref('');
const issued = ref<{ token: string; credentialId: string } | null>(null);
const credentials = ref<DeviceCredentialSummary[]>([]);
const listError = ref('');
const revoking = ref('');

onMounted(async () => {
  shows.value = await api<Show[]>('/api/shows');
  if (shows.value.length) selectedShow.value = shows.value[0].id;
  await loadCredentials();
});

// AC-016 (manage): the owner sees the device tokens already issued for the Show. The response is
// metadata only — no token is ever retrievable after issue.
// Owns its own error state so a failed refresh never leaves a stale list unexplained, and never
// overwrites the issue/revoke result when it is awaited after one of those mutations.
async function loadCredentials(): Promise<void> {
  if (!selectedShow.value) {
    credentials.value = [];
    listError.value = '';
    return;
  }
  try {
    const data = await api<{ credentials: DeviceCredentialSummary[] }>(
      `/api/shows/${encodeURIComponent(selectedShow.value)}/integrations/device-credentials`
    );
    credentials.value = data.credentials;
    listError.value = '';
  } catch (caught) {
    credentials.value = [];
    listError.value = caught instanceof Error ? caught.message : 'Could not load device tokens';
  }
}

// AC-016: the owner issues a device token scoped to a Show and selected actions; the token is
// shown exactly once and cannot be retrieved again.
async function issueToken(): Promise<void> {
  if (!selectedShow.value || issuing.value) return;
  issuing.value = true;
  error.value = '';
  issued.value = null;
  const scopes: string[] = [];
  if (scopeVisibility.value) scopes.push('component.visibility:write');
  if (scopeFeedback.value) scopes.push('feedback:read');
  try {
    const result = await api<{ token: string; credential: { credentialId: string } }>(
      `/api/shows/${encodeURIComponent(selectedShow.value)}/integrations/device-credentials`,
      { method: 'POST', body: JSON.stringify({ label: label.value, scopes, targets: ['program'], controlIds: [controlId.value.trim()], expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 30 }) }
    );
    issued.value = { token: result.token, credentialId: result.credential.credentialId };
    await loadCredentials();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Could not issue device token';
  } finally {
    issuing.value = false;
  }
}

// AC-016 (manage): revoking a token denies it immediately; the credential stays listed, marked
// revoked, so the owner can see it was retired.
async function revoke(credential: DeviceCredentialSummary): Promise<void> {
  if (revoking.value || credential.revokedAt) return;
  revoking.value = credential.credentialId;
  error.value = '';
  try {
    await api<{ credential: DeviceCredentialSummary }>(
      `/api/shows/${encodeURIComponent(selectedShow.value)}/integrations/device-credentials/${encodeURIComponent(credential.credentialId)}`,
      { method: 'DELETE' }
    );
    await loadCredentials();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Could not revoke device token';
  } finally {
    revoking.value = '';
  }
}
</script>

<template>
  <div class="page settings-page">
    <header class="page-header"><div><span class="eyebrow">LOCAL CONTROL</span><h1>Integrations</h1><p>Issue a scoped device token for a Stream Deck or other control surface.</p></div></header>

    <section class="inline-form" aria-label="Issue device token">
      <div class="form-grid">
        <label><span>Show</span><select v-model="selectedShow" @change="loadCredentials"><option v-for="s in shows" :key="s.id" :value="s.id">{{ s.name }}</option></select></label>
        <label><span>Label</span><input v-model="label" maxlength="80" placeholder="Stream Deck" /></label><label><span>Control id</span><input v-model="controlId" maxlength="120" placeholder="visibility.toggle" /></label>
      </div>
      <div class="scope-row">
        <label class="checkbox"><input type="checkbox" v-model="scopeVisibility" />Visibility control</label>
        <label class="checkbox"><input type="checkbox" v-model="scopeFeedback" />State feedback</label>
      </div>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <button class="primary-button" type="button" :disabled="issuing || !selectedShow" @click="issueToken"><KeyRound :size="17" />Issue device token</button>
    </section>

    <section v-if="issued" class="issued-token" aria-label="Issued device token">
      <div class="issued-head"><KeyRound :size="18" /><strong>Device token issued</strong><span class="evidence-badge">SHOWN ONCE</span></div>
      <p>Copy this token now — it is shown once and cannot be retrieved again.</p>
      <code class="token-value" data-testid="device-token">{{ issued.token }}</code>
      <small>Credential {{ issued.credentialId }}</small>
    </section>

    <p v-if="listError" class="form-error" role="alert">{{ listError }}</p>

    <section v-if="credentials.length" class="credential-list" aria-label="Issued device tokens">
      <h2>Issued tokens</h2>
      <ul>
        <li v-for="credential in credentials" :key="credential.credentialId" class="credential-row" :data-testid="`credential-${credential.credentialId}`">
          <div class="credential-meta">
            <strong>{{ credential.label }}</strong>
            <span class="credential-scopes">{{ credential.scopes.join(', ') }}</span>
            <span v-if="credential.revokedAt" class="status-badge revoked" data-testid="credential-status">Revoked</span>
            <span v-else class="status-badge active" data-testid="credential-status">Active</span>
          </div>
          <button class="danger-button" type="button" :disabled="!!credential.revokedAt || revoking === credential.credentialId" @click="revoke(credential)">Revoke</button>
        </li>
      </ul>
    </section>

    <div class="evidence-note"><Cable :size="17" /><p>A device token executes only its selected actions for its Show; revoke it here to deny it immediately.</p></div>
  </div>
</template>
