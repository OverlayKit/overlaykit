import { createRouter, createWebHistory } from 'vue-router';
import { auth } from './auth';
import AuthView from './views/AuthView.vue';
import ShowsView from './views/ShowsView.vue';
import ShowView from './views/ShowView.vue';
import ProductionView from './views/ProductionView.vue';
import ScenesView from './views/ScenesView.vue';
import EditorView from './views/EditorView.vue';
import LibraryView from './views/LibraryView.vue';
import SecurityView from './views/SecurityView.vue';
import IntegrationsView from './views/IntegrationsView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/setup', component: AuthView, meta: { public: true, mode: 'setup' } },
    { path: '/login', component: AuthView, meta: { public: true, mode: 'login' } },
    { path: '/', redirect: '/shows' },
    { path: '/shows', component: ShowsView },
    {
      path: '/shows/:showId',
      component: ShowView,
      children: [
        { path: '', redirect: { name: 'production' } },
        { path: 'production', name: 'production', component: ProductionView },
        { path: 'scenes', name: 'scenes', component: ScenesView },
        { path: 'scenes/:sceneId/edit', name: 'edit-scene', component: EditorView },
        { path: 'new-scene', name: 'new-scene', component: EditorView },
        { path: 'security', name: 'show-security', component: SecurityView },
      ],
    },
    { path: '/library', component: LibraryView },
    { path: '/settings/security', component: SecurityView },
    { path: '/settings/integrations', component: IntegrationsView },
    { path: '/:pathMatch(.*)*', redirect: '/shows' },
  ],
});

router.beforeEach(async (to) => {
  const status = await auth.refresh();
  if (status.setupRequired && to.path !== '/setup') return '/setup';
  if (!status.setupRequired && to.path === '/setup') return status.authenticated ? '/shows' : '/login';
  if (!to.meta.public && !status.authenticated) {
    return { path: '/login', query: { returnTo: to.fullPath } };
  }
  if (to.path === '/login' && status.authenticated) return '/shows';
  return true;
});
