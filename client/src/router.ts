import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router';
import ProductionView from './components/ProductionView.vue';

const routes: RouteRecordRaw[] = [
  {
    path: '/production',
    name: 'Production',
    component: ProductionView,
  },
  {
    path: '/',
    // Preserve any incoming query (channel, t playback token, transparent) instead
    // of hardcoding, so OBS links keep channel and display flags.
    redirect: (to) => ({
      path: '/production',
      query: Object.keys(to.query).length ? to.query : { channel: 'main', transparent: 'true' },
    }),
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
