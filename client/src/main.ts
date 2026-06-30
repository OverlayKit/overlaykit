import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { logger, setLogLevel } from './utils/logger';
import './style.css';

const app = createApp(App);

// Setup logger
if (!__DEV__) {
  setLogLevel('warn');
}

logger.info('Initializing OverlayKit Client');

// Use plugins
app.use(createPinia());
app.use(router);

// Mount app
app.mount('#app');
