<script setup lang="ts">
import { Cable, MonitorSmartphone, Usb } from '@lucide/vue';
</script>

<template>
  <div class="page settings-page">
    <header class="page-header"><div><span class="eyebrow">LOCAL CONTROL</span><h1>Integrations</h1><p>External control surfaces connected to this instance.</p></div></header>
    <section class="integration-row"><span class="integration-icon"><Usb :size="20" /></span><div><strong>Stream Deck on Linux</strong><p>Device credentials and action binding are pending protocol evidence.</p></div><span class="evidence-badge">PLANNED</span></section>
    <section class="integration-row"><span class="integration-icon"><MonitorSmartphone :size="20" /></span><div><strong>Remote control clients</strong><p>No purpose-scoped device credentials have been issued.</p></div><span class="evidence-badge neutral">NONE</span></section>
    <div class="evidence-note"><Cable :size="17" /><p>These integrations remain unavailable until authentication and capability rules have executable evidence.</p></div>
  </div>
</template>
