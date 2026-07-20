<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, post, type TableResult } from '../api';
import SqlEditor from '../components/SqlEditor.vue';
import LogPanel from '../components/LogPanel.vue';
import PanelControls from '../components/PanelControls.vue';

type Item = { id: string } & Record<string, unknown>;
type SavedQuery = { id: string; name: string; sql: string; instanceId: string; databaseId: string };
type SqlEditorHandle = { selectedText: () => string };
const instances = ref<Item[]>([]);
const instance = ref('');
const databases = ref<Item[]>([]);
const database = ref('');
const tables = ref<TableResult | null>(null);
const selectedTable = ref('');
const schema = ref<TableResult | null>(null);
const sql = ref('SELECT * FROM Customers LIMIT 100');
const result = ref<TableResult | null>(null);
const savedQueries = ref<SavedQuery[]>([]);
const savedQueriesOpen = ref(false);
const editor = ref<SqlEditorHandle | null>(null);
const executing = ref(false);
const text = (value: unknown) => (typeof value === 'string' ? value : String(value ?? ''));
const namedRows = (data: TableResult | null) => (data?.rows as Array<{ name: string }>) ?? [];
const fail = (cause: unknown) => ElMessage.error(cause instanceof Error ? cause.message : 'Spanner request failed');
const isDialogDismissal = (cause: unknown) => cause === 'cancel' || cause === 'close' || cause === 'escape';
async function load() {
  try {
    instances.value = (await api<TableResult>('/spanner/instances')).rows as Item[];
    instance.value ||= instances.value[0]?.id ?? '';
    if (instance.value) await loadDatabases();
  } catch (cause) {
    fail(cause);
  }
}
async function loadDatabases() {
  try {
    databases.value = (await api<TableResult>(`/spanner/instances/${encodeURIComponent(instance.value)}/databases`))
      .rows as Item[];
    database.value = databases.value.some((item) => item.id === database.value)
      ? database.value
      : (databases.value[0]?.id ?? '');
    if (database.value) await loadContext();
  } catch (cause) {
    fail(cause);
  }
}
async function loadContext() {
  await Promise.all([loadTables(), loadSavedQueries()]);
}
function resetExplorer() {
  selectedTable.value = '';
  schema.value = null;
  tables.value = null;
  savedQueries.value = [];
}
async function handleInstanceChange() {
  database.value = '';
  resetExplorer();
  await loadDatabases();
}
async function handleDatabaseChange() {
  resetExplorer();
  await loadContext();
}
async function loadTables() {
  try {
    tables.value = await api<TableResult>(
      `/spanner/databases/${encodeURIComponent(database.value)}/tables?instance=${encodeURIComponent(instance.value)}`
    );
    const available = namedRows(tables.value).map((item) => item.name);
    if (!available.includes(selectedTable.value)) {
      selectedTable.value = '';
      schema.value = null;
    }
  } catch (cause) {
    fail(cause);
  }
}
async function selectTable(tableName: string, updateSql = true) {
  selectedTable.value = tableName;
  if (updateSql) sql.value = `SELECT * FROM ${tableName} LIMIT 100`;
  try {
    schema.value = await api<TableResult>(
      `/spanner/databases/${encodeURIComponent(database.value)}/tables/${encodeURIComponent(tableName)}/schema?instance=${encodeURIComponent(instance.value)}`
    );
  } catch (cause) {
    fail(cause);
  }
}
async function toggleTable(tableName: string) {
  if (selectedTable.value === tableName) {
    selectedTable.value = '';
    schema.value = null;
    return;
  }
  await selectTable(tableName);
}
async function execute(statement = sql.value) {
  if (!statement.trim()) return ElMessage.warning('Enter a SELECT or WITH query first');
  executing.value = true;
  try {
    result.value = await post<TableResult>('/spanner/query', {
      instanceId: instance.value,
      databaseId: database.value,
      sql: statement,
    });
  } catch (cause) {
    fail(cause);
  } finally {
    executing.value = false;
  }
}
function executeAll() {
  return execute(sql.value);
}
async function executeSelection() {
  const selection = editor.value?.selectedText() ?? '';
  if (!selection) return ElMessage.warning('Select a SQL statement in the editor first');
  await execute(selection);
}
async function loadSavedQueries() {
  if (!instance.value || !database.value) return;
  try {
    savedQueries.value = (
      await api<{ rows: SavedQuery[] }>(
        `/spanner/saved-queries?instanceId=${encodeURIComponent(instance.value)}&databaseId=${encodeURIComponent(database.value)}`
      )
    ).rows;
  } catch (cause) {
    fail(cause);
  }
}
async function saveQuery() {
  if (!sql.value.trim()) return ElMessage.warning('Enter SQL before saving');
  try {
    const { value } = await ElMessageBox.prompt('Name this saved query', 'Save SQL', {
      inputPlaceholder: 'Customer list',
      inputValidator: (value) => (value.trim() ? true : 'A name is required'),
    });
    await post('/spanner/saved-queries', {
      name: value,
      instanceId: instance.value,
      databaseId: database.value,
      sql: sql.value,
    });
    ElMessage.success('SQL saved');
    await loadSavedQueries();
  } catch (cause) {
    if (!isDialogDismissal(cause)) fail(cause);
  }
}
async function openSavedQueries() {
  await loadSavedQueries();
  savedQueriesOpen.value = true;
}
function openSavedQuery(query: SavedQuery) {
  sql.value = query.sql;
  savedQueriesOpen.value = false;
}
onMounted(load);
</script>
<template>
  <section>
    <div class="workspace spanner-workspace">
      <section class="panel">
        <header class="panel-header"><strong>Spanner explorer</strong><PanelControls /></header>
        <div class="panel-body">
          <el-select v-model="instance" style="width: 100%; margin-bottom: 8px" @change="handleInstanceChange"
            ><el-option v-for="item in instances" :key="item.id" :label="item.id" :value="item.id" /></el-select
          ><el-select v-model="database" style="width: 100%" @change="handleDatabaseChange"
            ><el-option v-for="item in databases" :key="item.id" :label="item.id" :value="item.id"
          /></el-select>
          <div class="list">
            <template v-for="item in namedRows(tables)" :key="item.name">
              <button :class="{ active: selectedTable === item.name }" @click="toggleTable(item.name)">
                <span>▤ {{ item.name }}</span
                ><span class="table-chevron">{{ selectedTable === item.name ? '⌃' : '⌄' }}</span>
              </button>
              <div v-if="selectedTable === item.name && schema" class="table-schema">
                <div v-for="column in schema.rows" :key="text(column.column)" class="schema-column">
                  <strong>{{ text(column.column) }}</strong>
                  <span>{{ text(column.type) }}{{ text(column.nullable) === 'YES' ? ' · nullable' : '' }}</span>
                </div>
              </div>
            </template>
          </div>
        </div>
      </section>
      <section class="panel">
        <header class="panel-header">
          <div><strong>Spanner query studio</strong><small>Read-only SELECT/WITH</small></div>
          <PanelControls />
        </header>
        <div class="panel-body">
          <SqlEditor ref="editor" v-model="sql" />
          <div class="toolbar">
            <el-button type="primary" :loading="executing" @click="executeAll">Execute all</el-button>
            <el-button :loading="executing" @click="executeSelection">Execute selection</el-button>
            <el-button @click="saveQuery">Save SQL</el-button>
            <el-button @click="openSavedQueries">Open SQL</el-button>
            <span class="toolbar-hint">Highlight one SELECT/WITH statement to run only that selection.</span>
          </div>
          <el-table :data="result?.rows" stripe max-height="310"
            ><el-table-column
              v-for="column in result?.columns"
              :key="column.key"
              :prop="column.key"
              :label="column.label"
              min-width="140"
          /></el-table>
          <p v-if="result" class="query-summary">
            {{ result.metadata.rowCount }} row(s) returned in {{ result.metadata.durationMs }} ms
          </p>
        </div>
      </section>
    </div>
    <el-dialog v-model="savedQueriesOpen" title="Saved SQL" width="min(880px, 92vw)">
      <el-table
        :data="savedQueries"
        class="saved-query-table"
        empty-text="No SQL saved for this database yet."
        @row-click="openSavedQuery"
      >
        <el-table-column prop="name" label="Name" min-width="180" />
        <el-table-column prop="sql" label="SQL" min-width="440" show-overflow-tooltip />
      </el-table>
      <template #footer><span class="dialog-footer">Click a row to open it in the query editor.</span></template>
    </el-dialog>
    <LogPanel title="Spanner emulator logs" url="/api/services/spanner/logs/events" />
  </section>
</template>

<style scoped>
.spanner-workspace {
  grid-template-columns: 300px minmax(0, 1fr);
}
.table-schema {
  display: grid;
  gap: 6px;
  margin: 2px 6px 8px 16px;
  padding: 8px;
  border-left: 2px solid #315a91;
  background: #0b1523;
}
.schema-column {
  padding: 9px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #0d1726;
}
.schema-column strong,
.schema-column span {
  display: block;
}
.schema-column span,
.toolbar-hint,
.query-summary {
  color: var(--muted);
  font-size: 11px;
}
.schema-column span {
  margin-top: 3px;
}
.query-summary {
  margin: 10px 0 0;
}
.table-chevron {
  color: var(--muted);
  font-size: 14px;
}
.saved-query-table :deep(.el-table__row) {
  cursor: pointer;
}
.dialog-footer {
  color: var(--muted);
  font-size: 12px;
}
@media (max-width: 1180px) {
  .spanner-workspace {
    grid-template-columns: 1fr;
  }
}
</style>
