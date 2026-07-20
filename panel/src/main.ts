import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import { ensureStudioSession } from '../../shared/studioAccess';

if (await ensureStudioSession()) createApp(App).mount('#app');
