<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, del, post, type JsonRecord, type TableResult } from '../api';
import LogPanel from '../components/LogPanel.vue';
import PanelControls from '../components/PanelControls.vue';

const topics = ref<TableResult | null>(null);
const groups = ref<TableResult | null>(null);
const partitions = ref<TableResult | null>(null);
const topic = ref('');
const createOpen = ref(false);
const newTopic = ref('');
const partitionCount = ref(1);
const key = ref('');
const value = ref('{"event":"created"}');
const text = (value: unknown) => (typeof value === 'string' ? value : String(value ?? ''));
const namedRows = (data: TableResult | null) => (data?.rows as JsonRecord[]) ?? [];
const fail = (cause: unknown) => ElMessage.error(cause instanceof Error ? cause.message : 'Kafka request failed');
async function load() {
  try {
    topics.value = await api<TableResult>('/kafka/topics');
    groups.value = await api<TableResult>('/kafka/consumer-groups');
    topic.value ||= text(topics.value.rows[0]?.name);
    if (topic.value) await loadPartitions();
  } catch (cause) {
    fail(cause);
  }
}
async function loadPartitions() {
  try {
    partitions.value = await api<TableResult>(`/kafka/topics/${encodeURIComponent(topic.value)}/partitions`);
  } catch (cause) {
    fail(cause);
  }
}
function selectTopic(row: JsonRecord) {
  topic.value = text(row.name);
  void loadPartitions();
}
async function createTopic() {
  try {
    await post('/kafka/topics', { name: newTopic.value, partitions: partitionCount.value, replicationFactor: 1 });
    createOpen.value = false;
    await load();
  } catch (cause) {
    fail(cause);
  }
}
async function produce() {
  try {
    await post('/kafka/messages', { topic: topic.value, key: key.value || undefined, value: value.value });
    ElMessage.success('Message produced');
  } catch (cause) {
    fail(cause);
  }
}
async function removeTopic() {
  try {
    const confirmation = await ElMessageBox.prompt(`Nhập lại tên ${topic.value} để xóa`, 'Delete Kafka topic');
    await del(`/kafka/topics/${encodeURIComponent(topic.value)}`, { confirmation: confirmation.value });
    await load();
  } catch {
    /* confirmation cancelled */
  }
}
onMounted(load);
</script>
<template>
  <section>
    <div class="workspace wide">
      <section class="panel">
        <header class="panel-header">
          <div><strong>Kafka workspace</strong><small>Topics, partitions và consumer groups</small></div>
          <div>
            <el-button type="primary" size="small" @click="createOpen = true">Create topic</el-button><PanelControls />
          </div>
        </header>
        <el-tabs
          ><el-tab-pane label="Topics"
            ><el-table :data="topics?.rows" stripe max-height="330" @row-click="selectTopic"
              ><el-table-column
                v-for="column in topics?.columns"
                :key="column.key"
                :prop="column.key"
                :label="column.label" /></el-table></el-tab-pane
          ><el-tab-pane label="Partitions"
            ><el-table :data="partitions?.rows" stripe
              ><el-table-column
                v-for="column in partitions?.columns"
                :key="column.key"
                :prop="column.key"
                :label="column.label" /></el-table></el-tab-pane
          ><el-tab-pane label="Consumer groups"
            ><el-table :data="groups?.rows" stripe
              ><el-table-column
                v-for="column in groups?.columns"
                :key="column.key"
                :prop="column.key"
                :label="column.label" /></el-table></el-tab-pane
        ></el-tabs>
      </section>
      <section class="panel">
        <header class="panel-header"><strong>Message producer</strong><PanelControls /></header>
        <div class="panel-body">
          <el-select v-model="topic" style="width: 100%; margin-bottom: 8px"
            ><el-option
              v-for="item in namedRows(topics)"
              :key="text(item.name)"
              :label="text(item.name)"
              :value="text(item.name)" /></el-select
          ><el-input v-model="key" placeholder="Message key" /><el-input
            v-model="value"
            type="textarea"
            :rows="8"
            style="margin-top: 8px"
          />
          <div class="toolbar">
            <el-button type="primary" @click="produce">Produce</el-button
            ><el-button type="danger" plain @click="removeTopic">Delete selected topic</el-button>
          </div>
        </div>
      </section>
    </div>
    <el-dialog v-model="createOpen" title="Create Kafka topic"
      ><el-form label-position="top"
        ><el-form-item label="Topic name"><el-input v-model="newTopic" /></el-form-item
        ><el-form-item label="Partitions"
          ><el-input-number v-model="partitionCount" :min="1" :max="24" /></el-form-item></el-form
      ><template #footer
        ><el-button @click="createOpen = false">Cancel</el-button
        ><el-button type="primary" @click="createTopic">Create</el-button></template
      ></el-dialog
    ><LogPanel title="Kafka broker logs" url="/api/services/kafka/logs/events" />
  </section>
</template>
