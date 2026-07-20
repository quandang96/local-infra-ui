<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, del } from '../api';
import { useInfraStore } from '../stores/infra';
import PanelControls from '../components/PanelControls.vue';

type TaskRecord = {
  id: string;
  service_id: string;
  action_id: string;
  status: string;
  created_at: string;
  duration_ms?: number;
};
const infra = useInfraStore();
const rows = ref<TaskRecord[]>([]);
const selectedTasks = ref<TaskRecord[]>([]);
const search = ref('');
const status = ref('');
const loading = ref(false);
let searchTimer: number | undefined;

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : 'Unable to load task history');
const isDialogDismissal = (cause: unknown) => cause === 'cancel' || cause === 'close' || cause === 'escape';
async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ limit: '200' });
    if (search.value.trim()) params.set('q', search.value.trim());
    if (status.value) params.set('status', status.value);
    rows.value = (await api<{ rows: TaskRecord[] }>(`/tasks/history?${params}`)).rows;
    selectedTasks.value = [];
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  } finally {
    loading.value = false;
  }
}
function refresh() {
  void Promise.all([load(), infra.refresh()]);
}
async function removeSelected() {
  if (!selectedTasks.value.length) return;
  try {
    await ElMessageBox.confirm(
      `Delete ${selectedTasks.value.length} selected task record(s)? Running tasks are kept.`,
      'Delete task history',
      { type: 'warning' }
    );
    const result = await del<{ deleted: number; skipped: number }>('/tasks', {
      taskIds: selectedTasks.value.map((task) => task.id),
    });
    ElMessage.success(
      `Deleted ${result.deleted} task record(s)${result.skipped ? `; ${result.skipped} active task(s) kept` : ''}`
    );
    refresh();
  } catch (cause) {
    if (!isDialogDismissal(cause)) ElMessage.error(errorMessage(cause));
  }
}
watch([search, status], () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(load, 250);
});
onMounted(refresh);
</script>
<template>
  <section class="panel">
    <header class="panel-header">
      <div><strong>Task History</strong><small>Audit trail</small></div>
      <div class="panel-actions">
        <el-button type="danger" plain :disabled="!selectedTasks.length" @click="removeSelected"
          >Delete selected</el-button
        >
        <el-button :loading="loading || infra.loading" @click="refresh">Refresh</el-button><PanelControls />
      </div>
    </header>
    <div class="panel-body task-filters">
      <el-input v-model="search" clearable placeholder="Search task ID, service, action or status" />
      <el-select v-model="status" clearable placeholder="All statuses">
        <el-option label="Queued" value="queued" /><el-option label="Running" value="running" />
        <el-option label="Succeeded" value="succeeded" /><el-option label="Failed" value="failed" />
        <el-option label="Cancelled" value="cancelled" />
      </el-select>
    </div>
    <el-table :data="rows" stripe @selection-change="selectedTasks = $event"
      ><el-table-column type="selection" width="48" /><el-table-column
        prop="id"
        label="Task ID"
        min-width="220" /><el-table-column prop="service_id" label="Service" /><el-table-column
        prop="action_id"
        label="Action"
        min-width="220" /><el-table-column prop="status" label="Status" /><el-table-column
        prop="duration_ms"
        label="Duration ms" /><el-table-column prop="created_at" label="Started" min-width="180"
    /></el-table>
  </section>
</template>

<style scoped>
.panel-actions,
.task-filters {
  display: flex;
  align-items: center;
  gap: 10px;
}
.task-filters {
  padding-bottom: 12px;
}
.task-filters :deep(.el-input) {
  max-width: 440px;
}
.task-filters :deep(.el-select) {
  width: 160px;
}
@media (max-width: 820px) {
  .panel-actions,
  .task-filters {
    flex-wrap: wrap;
  }
}
</style>
