<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from '../ui';
import { useRoute } from 'vue-router';
import { api, post, serviceStatusClass, serviceStatusLabel, type Service } from '../api';
import LogPanel from '../components/LogPanel.vue';
import PanelControls from '../components/PanelControls.vue';
import { useInfraStore } from '../stores/infra';

const route = useRoute();
const infra = useInfraStore();
const service = ref<Service | null>(null);
const loading = ref(false);
const logTail = ref(100);
const serviceId = computed(() => String(route.params.serviceId ?? ''));
const fail = (cause: unknown) => ElMessage.error(cause instanceof Error ? cause.message : 'Service request failed');

async function load() {
  loading.value = true;
  try {
    service.value = await api<Service>(`/services/${encodeURIComponent(serviceId.value)}`);
  } catch (cause) {
    service.value = null;
    fail(cause);
  } finally {
    loading.value = false;
  }
}
async function lifecycle(action: 'start' | 'stop' | 'restart') {
  if (!service.value || service.value.runtimeMode !== 'daemon') return;
  try {
    await post(`/services/${service.value.id}/${action}`);
    ElMessage.success(`${service.value.label}: ${action} started`);
    window.setTimeout(() => {
      void Promise.all([load(), infra.refresh()]);
    }, 500);
  } catch (cause) {
    fail(cause);
  }
}

watch(serviceId, load, { immediate: true });
</script>

<template>
  <section class="panel">
    <header class="panel-header">
      <div>
        <strong>{{ service?.label ?? 'Compose service' }}</strong>
        <small>{{ service?.compose ?? serviceId }}</small>
      </div>
      <PanelControls />
    </header>
    <div v-if="service" class="panel-body">
      <div class="service-details">
        <span
          >Status
          <b class="status" :class="serviceStatusClass(service.status)">{{
            serviceStatusLabel(service.status)
          }}</b></span
        >
        <span
          >Image <b>{{ service.image }}</b></span
        >
        <span
          >Ports <b>{{ service.ports.join(' / ') || '—' }}</b></span
        >
        <span
          >Container <b>{{ service.container ?? 'resolved from Compose labels' }}</b></span
        >
      </div>
      <div v-if="service.runtimeMode === 'daemon'" class="toolbar">
        <v-btn color="success" prepend-icon="mdi-play" @click="lifecycle('start')">Start</v-btn>
        <v-btn color="warning" prepend-icon="mdi-restart" @click="lifecycle('restart')">Restart</v-btn>
        <v-btn color="error" prepend-icon="mdi-stop" @click="lifecycle('stop')">Stop</v-btn>
        <v-btn prepend-icon="mdi-refresh" :loading="loading" @click="load">Refresh</v-btn>
      </div>
      <p v-else class="muted-copy">This is an on-demand Compose tool and cannot be started as a daemon.</p>
    </div>
  </section>
  <LogPanel
    v-if="service?.runtimeMode === 'daemon'"
    :key="service.id"
    v-model:tail="logTail"
    :title="`${service.label} logs`"
    :url="`/api/services/${service.id}/logs/events`"
  />
</template>

<style scoped>
.service-details {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.service-details span {
  display: grid;
  gap: 5px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--muted);
  font-size: 11px;
}
.service-details b {
  color: var(--text);
  font-size: 12px;
}
.muted-copy {
  color: var(--muted);
}
@media (max-width: 640px) {
  .service-details {
    grid-template-columns: 1fr;
  }
}
</style>
