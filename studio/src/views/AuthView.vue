<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowRight, Radio } from '@lucide/vue';
import { auth } from '../auth';

const route = useRoute();
const router = useRouter();
const mode = computed(() => route.meta.mode as 'setup' | 'login');
const displayName = ref('');
const email = ref('');
const password = ref('');
const error = ref('');
const submitting = ref(false);

async function submit(): Promise<void> {
  error.value = '';
  submitting.value = true;
  try {
    if (mode.value === 'setup') {
      await auth.setup({ displayName: displayName.value, email: email.value, password: password.value });
    } else {
      await auth.login({ email: email.value, password: password.value });
    }
    const returnTo = typeof route.query.returnTo === 'string' ? route.query.returnTo : '/shows';
    await router.push(returnTo);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Authentication failed';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="auth-page">
    <section class="auth-brand">
      <div class="auth-brand-lockup"><Radio :size="28" />OverlayKit</div>
      <h1>Studio</h1>
      <p>Build scenes, operate your show, and publish a protected browser source from one local workspace.</p>
      <div class="signal-lines" aria-hidden="true"><span /><span /><span /><span /></div>
    </section>

    <section class="auth-form-wrap">
      <form class="auth-form" @submit.prevent="submit">
        <header>
          <span class="eyebrow">{{ mode === 'setup' ? 'FIRST RUN' : 'LOCAL INSTANCE' }}</span>
          <h2>{{ mode === 'setup' ? 'Create the owner account' : 'Sign in to Studio' }}</h2>
          <p>{{ mode === 'setup' ? 'This account controls security and production access.' : 'Use the owner credentials for this instance.' }}</p>
        </header>

        <label v-if="mode === 'setup'">
          <span>Name</span>
          <input v-model="displayName" autocomplete="name" required minlength="2" maxlength="80" />
        </label>
        <label>
          <span>Email</span>
          <input v-model="email" type="email" autocomplete="email" required />
        </label>
        <label>
          <span>Password</span>
          <input v-model="password" type="password" :autocomplete="mode === 'setup' ? 'new-password' : 'current-password'" required minlength="12" maxlength="256" />
          <small v-if="mode === 'setup'">At least 12 characters</small>
        </label>

        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button class="primary-button" type="submit" :disabled="submitting">
          {{ submitting ? 'Working...' : mode === 'setup' ? 'Create owner' : 'Sign in' }}
          <ArrowRight :size="17" />
        </button>
      </form>
    </section>
  </main>
</template>
