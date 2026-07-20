<script setup lang="ts">
import { Blocks, Code2, LayoutTemplate, Plus } from '@lucide/vue';
</script>

<template>
  <div class="page">
    <header class="page-header"><div><span class="eyebrow">REUSABLE ASSETS</span><h1>Library</h1><p>Templates and components shared across your local shows.</p></div><RouterLink class="primary-button" to="/shows"><Plus :size="17" />Create in a show</RouterLink></header>
    <div class="library-sections">
      <section><header><LayoutTemplate :size="20" /><div><strong>Templates</strong><span>Starting points for complete scenes</span></div></header><div class="empty-state compact">Templates appear here when saved from the editor.</div></section>
      <section><header><Code2 :size="20" /><div><strong>Components</strong><span>Reusable visual and control units</span></div></header><div class="empty-state compact"><Blocks :size="24" />Components appear here when saved from the editor.</div></section>
    </div>
  </div>
</template>
