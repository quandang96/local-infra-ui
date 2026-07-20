<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api';
import LogPanel from '../components/LogPanel.vue';
import PanelControls from '../components/PanelControls.vue';

type Status = { available: boolean; statusCode: number; durationMs: number; openUrl: string | null };
const status = ref<Status | null>(null);
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
        <div>
          <strong>MySQL in Redash</strong
          ><small
            >Original Redash UI · first use: create the Redash admin account, then add MySQL datasource at host
            <code>mysql</code>, port <code>3306</code>, database <code>app</code>.</small
          >
        </div>
        <div>
          <el-tag :type="status?.available ? 'success' : 'danger'">HTTP {{ status?.statusCode ?? '—' }}</el-tag
          ><el-button style="margin-left: 8px" @click="open">Open new tab</el-button
          ><el-button style="margin-left: 8px" @click="load">Refresh</el-button>
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
          <el-button @click="load">Try again</el-button>
        </div>
      </div>
    </section>
    <LogPanel title="Redash container logs" url="/api/services/redash/logs/events" />
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
