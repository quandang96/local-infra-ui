<script setup lang="ts">
import { computed } from 'vue';
import { useInfraStore } from '../stores/infra';
import PanelControls from '../components/PanelControls.vue';
const infra = useInfraStore();
const fmtBytes = (value?: number) => (value == null ? '—' : `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`);
const docker = computed(() => JSON.stringify(infra.overview.system.docker ?? {}, null, 2));
</script>
<template>
  <section>
    <div class="metric-grid">
      <article class="metric">
        <small>CPU cores</small><strong>{{ infra.overview.system.cpuCores ?? '—' }}</strong>
      </article>
      <article class="metric">
        <small>Memory total</small><strong>{{ fmtBytes(infra.overview.system.memory?.total) }}</strong>
      </article>
      <article class="metric">
        <small>Process RSS</small><strong>{{ fmtBytes(infra.overview.system.memory?.processRss) }}</strong>
      </article>
      <article class="metric">
        <small>Uptime</small><strong>{{ Math.floor((infra.overview.system.uptimeSeconds ?? 0) / 3600) }} h</strong>
      </article>
    </div>
    <section class="panel">
      <header class="panel-header"><strong>Docker disk details</strong><PanelControls /></header>
      <pre class="raw">{{ docker }}</pre>
    </section>
  </section>
</template>
