<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import PanelControls from './PanelControls.vue';

const props = defineProps<{ title: string; url: string }>();
const lines = ref<{ timestamp: string; stream: string; text: string }[]>([]);
const search = ref('');
const stream = ref('all');
const tail = ref(100);
let source: EventSource | undefined;
let connectionId = 0;
const normaliseText = (text: unknown) =>
  String(text ?? '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r');

function connect() {
  const currentConnection = ++connectionId;
  source?.close();
  lines.value = [];
  source = new EventSource(`${props.url}${props.url.includes('?') ? '&' : '?'}tail=${tail.value}`);
  source.addEventListener('log', (event) => {
    if (currentConnection !== connectionId) return;
    const line = JSON.parse((event as MessageEvent).data);
    lines.value.push({ ...line, text: normaliseText(line.text) });
    if (lines.value.length > 5000) lines.value.shift();
  });
  source.onerror = () => {
    /* EventSource reconnects automatically. */
  };
}
function clear() {
  lines.value = [];
}
function copy() {
  navigator.clipboard?.writeText(
    visible.value.map((line) => `[${line.timestamp}] [${line.stream}] ${line.text}`).join('\n')
  );
}
const visible = ref<typeof lines.value>([]);
watch(
  [lines, search, stream],
  () => {
    const q = search.value.toLowerCase();
    visible.value = lines.value.filter(
      (line) => (stream.value === 'all' || line.stream === stream.value) && (!q || line.text.toLowerCase().includes(q))
    );
  },
  { deep: true, immediate: true }
);
watch(() => props.url, connect, { immediate: true });
onBeforeUnmount(() => {
  connectionId += 1;
  source?.close();
});
</script>

<template>
  <section class="panel logs-panel">
    <header class="panel-header">
      <div>
        <strong>{{ title }}</strong
        ><small>Realtime SSE · tối đa 5.000 dòng</small>
      </div>
      <div class="log-tools">
        <div class="log-filters">
          <el-select v-model="tail" size="small" style="width: 100px" @change="connect"
            ><el-option :value="10" label="Tail 10" /><el-option :value="50" label="Tail 50" /><el-option
              :value="100"
              label="Tail 100" /><el-option :value="500" label="Tail 500" /><el-option
              :value="1000"
              label="Tail 1000" /></el-select
          ><el-select v-model="stream" size="small" style="width: 100px"
            ><el-option value="all" label="All" /><el-option value="stdout" label="stdout" /><el-option
              value="stderr"
              label="stderr" /><el-option value="system" label="system" /></el-select
          ><el-input v-model="search" size="small" placeholder="Search logs" clearable />
        </div>
        <div class="log-actions">
          <el-button size="small" @click="copy">Copy</el-button
          ><el-button size="small" type="danger" plain @click="clear">Clear UI</el-button><PanelControls />
        </div>
      </div>
    </header>
    <pre
      class="terminal"
    ><span v-for="(line, index) in visible" :key="index" :class="['log-line', line.stream]">[{{ line.timestamp }}] [{{ line.stream }}] {{ line.text }}</span></pre>
  </section>
</template>

<style scoped>
.log-line {
  display: block;
}
.logs-panel {
  display: flex;
  height: calc(100vh - 180px);
  min-height: 360px;
  flex-direction: column;
}
.logs-panel .terminal {
  height: auto;
  min-height: 0;
  max-height: none;
  flex: 1 1 auto;
}
.logs-panel .panel-header {
  align-items: flex-start;
  flex-wrap: wrap;
}
.log-tools,
.log-filters,
.log-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.log-tools {
  min-width: 0;
  flex: 1 1 510px;
  justify-content: flex-end;
  flex-wrap: wrap;
}
.log-filters {
  flex: 0 1 auto;
}
.log-filters :deep(.el-input) {
  width: clamp(160px, 18vw, 220px);
  min-width: 0;
  flex: 0 1 190px;
}
.log-actions {
  flex: 0 0 auto;
}
.log-actions :deep(.panel-controls) {
  margin-left: 0;
}
@media (max-width: 680px) {
  .log-tools,
  .log-actions {
    justify-content: flex-start;
  }
  .log-filters {
    flex-basis: 100%;
    flex-wrap: wrap;
  }
  .log-filters :deep(.el-input) {
    flex: 1 1 170px;
  }
}
</style>
