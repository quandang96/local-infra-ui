<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from '../ui';
import { api, del, post, type JsonRecord, type TableResult } from '../api';
import LogPanel from '../components/LogPanel.vue';
import PanelControls from '../components/PanelControls.vue';

const topics = ref<TableResult | null>(null);
const groups = ref<TableResult | null>(null);
const logTail = ref(100);
const partitions = ref<TableResult | null>(null);
const topic = ref('');
const createOpen = ref(false);
const newTopic = ref('');
const partitionCount = ref(1);
const key = ref('');
const value = ref('');
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
            <v-btn size="small" color="primary" variant="flat" prepend-icon="mdi-plus" @click="createOpen = true">
              Create topic
            </v-btn>
            <PanelControls />
          </div>
        </header>
        <el-tabs class="kafka-topic-tabs"
          ><el-tab-pane label="Topics"
            ><div class="kafka-table-content"
              ><el-table :data="topics?.rows" stripe max-height="330" @row-click="selectTopic"
                ><el-table-column
                  v-for="column in topics?.columns"
                  :key="column.key"
                  :prop="column.key"
                  :label="column.label" /></el-table></div></el-tab-pane
          ><el-tab-pane label="Partitions"
            ><div class="kafka-table-content"
              ><el-table :data="partitions?.rows" stripe max-height="330"
                ><el-table-column
                  v-for="column in partitions?.columns"
                  :key="column.key"
                  :prop="column.key"
                  :label="column.label" /></el-table></div></el-tab-pane
          ><el-tab-pane label="Consumer groups"
            ><div class="kafka-table-content"
              ><el-table :data="groups?.rows" stripe max-height="330"
                ><el-table-column
                  v-for="column in groups?.columns"
                  :key="column.key"
                  :prop="column.key"
                  :label="column.label" /></el-table></div></el-tab-pane
        ></el-tabs>
      </section>
      <section class="panel">
        <header class="panel-header"><strong>Message producer</strong><PanelControls /></header>
        <div class="panel-body">
          <v-select v-model="topic" :items="namedRows(topics).map((item) => text(item.name))" label="Topic" />
          <v-text-field v-model="key" class="mt-3" label="Message key" />
          <v-textarea
            v-model="value"
            class="mt-3"
            label="Message value"
            placeholder='{"event":"created"}'
            persistent-placeholder
            :rows="8"
          />
          <div class="toolbar">
            <v-btn color="primary" variant="flat" prepend-icon="mdi-send" @click="produce">Produce</v-btn>
            <v-btn color="error" prepend-icon="mdi-delete-outline" @click="removeTopic">Delete topic</v-btn>
          </div>
        </div>
      </section>
    </div>
    <v-dialog v-model="createOpen" max-width="520">
      <v-card rounded="xl">
        <v-card-title>Create Kafka topic</v-card-title>
        <v-card-text>
          <v-text-field v-model="newTopic" label="Topic name" autofocus />
          <v-text-field
            v-model.number="partitionCount"
            class="mt-3"
            type="number"
            label="Partitions"
            min="1"
            max="24"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="createOpen = false">Cancel</v-btn>
          <v-btn color="primary" variant="flat" @click="createTopic">Create</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <LogPanel v-model:tail="logTail" title="Kafka broker logs" url="/api/services/kafka/logs/events" />
  </section>
</template>

<style scoped>
.kafka-table-content {
  padding: 0 16px 16px;
}
.kafka-topic-tabs :deep(.el-tabs__header) {
  margin: 0 16px 15px;
}
</style>
