<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import PanelControls from './PanelControls.vue';

const props = withDefaults(defineProps<{ title: string; url: string; tail?: number }>(), { tail: 100 });
const emit = defineEmits<{ 'update:tail': [value: number] }>();
const lines = ref<{ timestamp: string; stream: string; text: string }[]>([]);
const search = ref('');
const stream = ref('all');
const tail = ref(props.tail);
let source: EventSource | undefined;
let connectionId = 0;
const normaliseText = (text: unknown) =>
  String(text ?? '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r');

function connect(tailCount = tail.value) {
  const currentConnection = ++connectionId;
  source?.close();
  lines.value = [];
  visible.value = [];
  source = new EventSource(`${props.url}${props.url.includes('?') ? '&' : '?'}tail=${tailCount}`);
  source.addEventListener('log', (event) => {
    if (currentConnection !== connectionId) return;
    const line = JSON.parse((event as MessageEvent).data);
    lines.value.push({ ...line, text: normaliseText(line.text) });
    while (lines.value.length > tail.value) lines.value.shift();
  });
  source.onerror = () => {
    /* EventSource reconnects automatically. */
  };
}
function changeTail(value: number) {
  tail.value = value;
  emit('update:tail', value);
  connect(value);
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
watch(
  () => props.url,
  () => connect(),
  { immediate: true }
);
watch(
  () => props.tail,
  (value) => {
    tail.value = value;
  }
);
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
        ><small>Realtime SSE · giữ {{ tail }} dòng mới nhất</small>
      </div>
      <div class="log-tools">
        <div class="log-filters">
          <v-select
            v-model="tail"
            :items="[10, 50, 100, 500, 1000].map((value) => ({ title: `Tail ${value}`, value }))"
            style="width: 112px"
            aria-label="Log tail"
            @update:model-value="changeTail"
          />
          <v-select v-model="stream" :items="['all', 'stdout', 'stderr', 'system']" style="width: 112px" />
          <v-text-field v-model="search" placeholder="Search logs" clearable prepend-inner-icon="mdi-magnify" />
        </div>
        <div class="log-actions">
          <v-btn size="small" prepend-icon="mdi-content-copy" @click="copy">Copy</v-btn>
          <v-btn size="small" color="error" variant="tonal" prepend-icon="mdi-delete-outline" @click="clear">
            Clear
          </v-btn>
          <PanelControls />
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
.log-filters :deep(.v-text-field) {
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
  .log-filters :deep(.v-text-field) {
    flex: 1 1 170px;
  }
}
</style>
