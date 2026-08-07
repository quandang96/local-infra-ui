<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from '../ui';
import { api } from '../api';
import LogPanel from '../components/LogPanel.vue';
import PanelControls from '../components/PanelControls.vue';

const props = defineProps<{
  serviceId: 'keycloak' | 'mailhog';
  label: string;
  description: string;
  embeddedUrl: string;
}>();

type Status = { available: boolean; statusCode: number; durationMs: number; openUrl: string | null };
const status = ref<Status | null>(null);
const openUrl = ref<string | null>(null);
const logTail = ref(100);

async function load() {
  try {
    const [nextStatus, target] = await Promise.all([
      api<Status>(`/${props.serviceId}/status`),
      api<{ url: string | null }>(`/${props.serviceId}/open-url`),
    ]);
    status.value = nextStatus;
    openUrl.value = target.url;
  } catch (cause: unknown) {
    ElMessage.error(cause instanceof Error ? cause.message : `${props.label} check failed`);
  }
}

function open() {
  if (openUrl.value) window.open(openUrl.value, '_blank', 'noopener');
  else ElMessage.warning(`${props.label} URL has not been configured`);
}

onMounted(load);
</script>

<template>
  <section>
    <section class="panel embedded-service-ui">
      <header class="panel-header">
        <div>
          <strong>{{ label }}</strong
          ><small>{{ description }}</small>
        </div>
        <div>
          <v-chip size="small" :color="status?.available ? 'success' : 'error'" variant="tonal">
            HTTP {{ status?.statusCode ?? '—' }}
          </v-chip>
          <v-btn size="small" append-icon="mdi-open-in-new" @click="open">Open</v-btn>
          <v-btn size="small" icon="mdi-refresh" title="Refresh" @click="load" />
          <PanelControls />
        </div>
      </header>
      <div v-if="status?.available" class="service-frame-wrap">
        <iframe :src="embeddedUrl" :title="label" class="service-frame" />
      </div>
      <div v-else class="availability">
        <div>
          <div class="big-check">!</div>
          <h2>{{ label }} unavailable</h2>
          <p>HTTP {{ status?.statusCode ?? '—' }} · {{ status?.durationMs ?? '—' }} ms</p>
          <v-btn prepend-icon="mdi-refresh" @click="load">Try again</v-btn>
        </div>
      </div>
    </section>
    <LogPanel
      v-model:tail="logTail"
      :title="`${label} container logs`"
      :url="`/api/services/${serviceId}/logs/events`"
    />
  </section>
</template>

<style scoped>
.embedded-service-ui {
  min-height: 760px;
}
.service-frame-wrap {
  height: 700px;
  background: #fff;
}
.service-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
.embedded-service-ui:fullscreen {
  min-height: 100vh;
}
.embedded-service-ui:fullscreen .service-frame-wrap {
  height: calc(100vh - 62px);
}
</style>
