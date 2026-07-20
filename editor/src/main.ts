import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { ensureStudioSession } from '../../shared/studioAccess'

if (await ensureStudioSession()) createApp(App).mount('#app')
