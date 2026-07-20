<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  Blocks,
  Cable,
  LogOut,
  Radio,
  Settings,
  ShieldCheck,
} from '@lucide/vue';
import { auth } from './auth';

const route = useRoute();
const router = useRouter();
const publicRoute = computed(() => Boolean(route.meta.public));

async function signOut(): Promise<void> {
  await auth.logout();
  await router.push('/login');
}
</script>

<template>
  <RouterView v-if="publicRoute" />
  <div v-else class="studio-shell">
    <aside class="sidebar">
      <RouterLink class="wordmark" to="/shows" aria-label="OverlayKit Studio">
        <span class="wordmark-mark"><Radio :size="19" /></span>
        <span>OverlayKit</span>
      </RouterLink>

      <nav class="primary-nav" aria-label="Studio">
        <RouterLink to="/shows"><Radio :size="17" />Shows</RouterLink>
        <RouterLink to="/library"><Blocks :size="17" />Library</RouterLink>
      </nav>

      <div class="sidebar-bottom">
        <span class="nav-label">Settings</span>
        <nav class="primary-nav" aria-label="Settings">
          <RouterLink to="/settings/security"><ShieldCheck :size="17" />Security</RouterLink>
          <RouterLink to="/settings/integrations"><Cable :size="17" />Integrations</RouterLink>
        </nav>
        <div class="account">
          <span class="account-avatar">{{ auth.state.session?.user.displayName.slice(0, 1).toUpperCase() }}</span>
          <span class="account-copy">
            <strong>{{ auth.state.session?.user.displayName }}</strong>
            <small>Local owner</small>
          </span>
          <button class="icon-button" type="button" title="Sign out" aria-label="Sign out" @click="signOut">
            <LogOut :size="16" />
          </button>
        </div>
      </div>
    </aside>

    <main class="workspace">
      <RouterView />
    </main>
  </div>
</template>
