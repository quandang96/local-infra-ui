<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api';
import LogPanel from '../components/LogPanel.vue';
import PanelControls from '../components/PanelControls.vue';

type Status = {
  available: boolean;
  statusCode: number;
  durationMs: number;
  openUrl: string | null;
};
const status = ref<Status | null>(null);
const logTail = ref(100);
const embeddedUrl = '/kafka-ui-embed/';
async function check() {
  try {
    status.value = await api<Status>('/kafka-ui/status');
  } catch (cause: unknown) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Kafka UI check failed');
  }
}
async function open() {
  const result = await api<{ url: string | null }>('/kafka-ui/open-url');
  if (result.url) window.open(result.url, '_blank', 'noopener');
  else ElMessage.warning('KAFKA_UI_OPEN_URL has not been configured');
}
onMounted(check);
</script>
<template>
  <section>
    <section class="panel embedded-kafka-ui">
      <header class="panel-header">
        <div>
          <strong>Kafka UI</strong><small>Original Kafka UI, proxied through Control Center for secure embedding</small>
        </div>
        <div>
          <el-tag :type="status?.available ? 'success' : 'danger'">HTTP {{ status?.statusCode ?? '—' }}</el-tag
          ><el-button style="margin-left: 8px" @click="open">Open new tab</el-button
          ><el-button style="margin-left: 8px" @click="check">Refresh status</el-button>
          <PanelControls />
        </div>
      </header>
      <div v-if="status?.available" class="kafka-ui-frame-wrap">
        <iframe :src="embeddedUrl" title="Kafka UI" class="kafka-ui-frame" />
      </div>
      <div v-else class="availability">
        <div>
          <div class="big-check">!</div>
          <h2>Kafka UI unavailable</h2>
          <p>HTTP {{ status?.statusCode ?? '—' }} · {{ status?.durationMs ?? '—' }} ms</p>
          <el-button @click="check">Try again</el-button>
        </div>
      </div>
    </section>
    <LogPanel v-model:tail="logTail" title="Kafka UI container logs" url="/api/services/kafka-ui/logs/events" />
  </section>
</template>

<style scoped>
.embedded-kafka-ui {
  min-height: 720px;
}
.kafka-ui-frame-wrap {
  height: 660px;
  background: #fff;
}
.kafka-ui-frame {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}
.embedded-kafka-ui:fullscreen {
  min-height: 100vh;
}
.embedded-kafka-ui:fullscreen .kafka-ui-frame-wrap {
  height: calc(100vh - 62px);
}
</style>
