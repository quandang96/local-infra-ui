<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from '../ui';
import { api } from '../api';
import LogPanel from '../components/LogPanel.vue';
import PanelControls from '../components/PanelControls.vue';

type Status = { available: boolean; statusCode: number; durationMs: number; openUrl: string | null };
const status = ref<Status | null>(null);
const logTail = ref(100);
const redashUrl = ref<string | null>(null);
const fail = (cause: unknown) => ElMessage.error(cause instanceof Error ? cause.message : 'Redash request failed');
async function load() {
  try {
    const [nextStatus, target] = await Promise.all([
      api<Status>('/redash/status'),
      api<{ url: string | null }>('/redash/open-url'),
    ]);
    status.value = nextStatus;
    redashUrl.value = target.url;
  } catch (cause) {
    fail(cause);
  }
}
function open() {
  if (redashUrl.value) window.open(redashUrl.value, '_blank', 'noopener');
  else ElMessage.warning('REDASH_OPEN_URL has not been configured');
}
onMounted(load);
</script>
<template>
  <section>
    <section class="panel embedded-redash">
      <header class="panel-header">
        <div><strong>MySQL in Redash</strong><small>Redash datasource · mysql:3306/app</small></div>
        <div>
          <v-chip size="small" :color="status?.available ? 'success' : 'error'" variant="tonal">
            HTTP {{ status?.statusCode ?? '—' }}
          </v-chip>
          <v-btn size="small" append-icon="mdi-open-in-new" @click="open">Open</v-btn>
          <v-btn size="small" icon="mdi-refresh" title="Refresh" @click="load" />
          <PanelControls />
        </div>
      </header>
      <div v-if="status?.available && redashUrl" class="redash-frame-wrap">
        <iframe :src="redashUrl" title="Redash" class="redash-frame" />
      </div>
      <div v-else class="availability">
        <div>
          <div class="big-check">!</div>
          <h2>Redash is unavailable</h2>
          <p>HTTP {{ status?.statusCode ?? '—' }} · {{ status?.durationMs ?? '—' }} ms</p>
          <v-btn prepend-icon="mdi-refresh" @click="load">Try again</v-btn>
        </div>
      </div>
    </section>
    <LogPanel v-model:tail="logTail" title="Redash container logs" url="/api/services/redash/logs/events" />
  </section>
</template>

<style scoped>
.embedded-redash {
  min-height: 760px;
}
.redash-frame-wrap {
  height: 700px;
  background: #fff;
}
.redash-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
.embedded-redash:fullscreen {
  min-height: 100vh;
}
.embedded-redash:fullscreen .redash-frame-wrap {
  height: calc(100vh - 62px);
}
code {
  color: #b7d7ff;
}
</style>
