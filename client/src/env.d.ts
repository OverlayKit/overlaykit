/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

interface ImportMetaEnv {
  readonly VITE_WS_URL: string
  // más variables de entorno...
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}