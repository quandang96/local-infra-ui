<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api, post, type JsonValue, type TableResult } from '../api';
import LogPanel from '../components/LogPanel.vue';
import SqlEditor from '../components/SqlEditor.vue';

type Status = { available: boolean; statusCode: number; durationMs: number; projectId: string };
type Dataset = { id: string; location: string | null };
type BigQueryTable = { id: string; type: string };

const status = ref<Status | null>(null);
const datasets = ref<Dataset[]>([]);
const selectedDataset = ref('');
const tables = ref<BigQueryTable[]>([]);
const sql = ref('SELECT 1 AS ready');
const result = ref<TableResult | null>(null);
const loading = ref(false);
const logTail = ref(100);
const editor = ref<{ selectedText: () => string }>();

const fail = (cause: unknown) =>
  ElMessage.error(cause instanceof Error ? cause.message : 'BigQuery emulator request failed');

async function load() {
  try {
    status.value = await api<Status>('/bigquery/status');
    if (!status.value.available) return;
    datasets.value = await api<Dataset[]>('/bigquery/datasets');
    if (!selectedDataset.value && datasets.value.length) selectedDataset.value = datasets.value[0]!.id;
  } catch (cause) {
    fail(cause);
  }
}

async function loadTables(dataset: string) {
  tables.value = [];
  if (!dataset) return;
  try {
    tables.value = await api<BigQueryTable[]>(`/bigquery/datasets/${encodeURIComponent(dataset)}/tables`);
  } catch (cause) {
    fail(cause);
  }
}

async function runQuery() {
  const statement = editor.value?.selectedText() || sql.value;
  if (!statement.trim()) return;
  loading.value = true;
  try {
    result.value = await post<TableResult>('/bigquery/query', { sql: statement });
  } catch (cause) {
    fail(cause);
  } finally {
    loading.value = false;
  }
}

function formatCell(value: JsonValue | undefined) {
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? 'NULL');
}

watch(selectedDataset, loadTables);
onMounted(load);
</script>

<template>
  <section>
    <div class="bq-summary">
      <section class="panel summary-card">
        <small>EMULATOR</small
        ><strong :class="status?.available ? 'online' : 'offline'">{{
          status?.available ? 'Online' : 'Offline'
        }}</strong
        ><span>HTTP {{ status?.statusCode ?? '—' }} · {{ status?.durationMs ?? '—' }} ms</span>
      </section>
      <section class="panel summary-card">
        <small>PROJECT</small><strong>{{ status?.projectId ?? 'local-project' }}</strong
        ><span>REST :9050 · Storage gRPC :9060</span>
      </section>
      <section class="panel summary-card">
        <small>DATASETS</small><strong>{{ datasets.length }}</strong
        ><span>Local SQLite-backed data</span>
      </section>
    </div>

    <div class="bq-workspace">
      <section class="panel explorer">
        <header class="panel-header">
          <div><strong>Explorer</strong><small>Datasets and tables</small></div>
        </header>
        <div class="explorer-body">
          <el-select v-model="selectedDataset" placeholder="Select dataset" style="width: 100%">
            <el-option v-for="dataset in datasets" :key="dataset.id" :label="dataset.id" :value="dataset.id" />
          </el-select>
          <div v-if="tables.length" class="table-list">
            <button
              v-for="entry in tables"
              :key="entry.id"
              type="button"
              @click="sql = `SELECT * FROM \`${selectedDataset}.${entry.id}\` LIMIT 100`"
            >
              <span>▦</span><b>{{ entry.id }}</b
              ><small>{{ entry.type }}</small>
            </button>
          </div>
          <el-empty v-else description="No tables in this dataset" :image-size="56" />
        </div>
      </section>

      <section class="panel query-panel">
        <header class="panel-header">
          <div>
            <strong>GoogleSQL query</strong><small>Read-only: SELECT, WITH or EXPLAIN · selection runs first</small>
          </div>
          <el-button type="primary" :loading="loading" :disabled="!status?.available" @click="runQuery"
            >Run query</el-button
          >
        </header>
        <SqlEditor ref="editor" v-model="sql" />
      </section>
    </div>

    <section class="panel result-panel">
      <header class="panel-header">
        <div>
          <strong>Query result</strong
          ><small>{{
            result ? `${result.metadata.rowCount} rows · ${result.metadata.durationMs} ms` : 'Run a query to see data'
          }}</small>
        </div>
      </header>
      <el-table v-if="result" :data="result.rows" height="360" stripe>
        <el-table-column
          v-for="column in result.columns"
          :key="column.key"
          :prop="column.key"
          :label="`${column.label} · ${column.dataType}`"
          min-width="160"
        >
          <template #default="scope">{{ formatCell(scope.row[column.key]) }}</template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="No query result" />
    </section>

    <LogPanel v-model:tail="logTail" title="BigQuery emulator logs" url="/api/services/bigquery/logs/events" />
  </section>
</template>

<style scoped>
.bq-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 14px;
}
.summary-card {
  display: flex;
  min-height: 104px;
  flex-direction: column;
  gap: 5px;
  padding: 18px;
}
.summary-card small,
.summary-card span {
  color: var(--muted);
}
.summary-card strong {
  font-size: 20px;
}
.summary-card .online {
  color: #4ade80;
}
.summary-card .offline {
  color: #fb7185;
}
.bq-workspace {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 14px;
  margin-bottom: 14px;
}
.explorer,
.query-panel {
  min-height: 410px;
}
.explorer-body {
  padding: 14px;
}
.table-list {
  display: grid;
  gap: 7px;
  margin-top: 12px;
}
.table-list button {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: center;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #101b2d;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.table-list button:hover {
  border-color: #4777ba;
}
.table-list small {
  color: var(--muted);
}
.query-panel :deep(.sql-editor) {
  height: 350px;
}
.result-panel {
  margin-bottom: 14px;
}
@media (max-width: 960px) {
  .bq-summary,
  .bq-workspace {
    grid-template-columns: 1fr;
  }
}
</style>
