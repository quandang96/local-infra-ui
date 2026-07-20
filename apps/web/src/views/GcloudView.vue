<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, post } from '../api';
import LogPanel from '../components/LogPanel.vue';
import PanelControls from '../components/PanelControls.vue';

type Action = { id: 'version' | 'config-list' | 'configurations' | 'auth-list'; label: string };
type Task = { taskId: string; eventUrl: string; status: string };
const actions = ref<Action[]>([]);
const actionId = ref<Action['id']>('config-list');
const project = ref('');
const task = ref<Task | null>(null);
async function load() {
  try {
    actions.value = await api<Action[]>('/gcloud/actions');
    actionId.value =
      actions.value.find((action) => action.id === actionId.value)?.id ?? actions.value[0]?.id ?? 'config-list';
  } catch (cause: unknown) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Cannot load gcloud actions');
  }
}
async function run() {
  try {
    task.value = await post<Task>('/gcloud/tasks', { actionId: actionId.value, project: project.value || undefined });
    ElMessage.success('gcloud task started');
  } catch (cause: unknown) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Cannot start gcloud task');
  }
}
async function cancel() {
  if (task.value) await post(`/tasks/${task.value.taskId}/cancel`);
}
onMounted(load);
</script>
<template>
  <section>
    <div class="workspace">
      <section class="panel">
        <header class="panel-header">
          <div><strong>Approved command catalog</strong><small>Không nhận shell command tùy ý</small></div>
          <PanelControls />
        </header>
        <div class="panel-body">
          <el-select v-model="actionId" style="width: 100%"
            ><el-option
              v-for="action in actions"
              :key="action.id"
              :label="action.label"
              :value="action.id" /></el-select
          ><el-input v-model="project" placeholder="Project override" style="margin-top: 10px" />
          <div class="toolbar">
            <el-button type="primary" @click="run">Run action</el-button
            ><el-button type="danger" plain :disabled="!task" @click="cancel">Cancel</el-button>
          </div>
        </div>
      </section>
      <section class="panel">
        <header class="panel-header"><strong>Task detail</strong><PanelControls /></header>
        <pre class="raw">{{ JSON.stringify(task ?? { status: 'Ready' }, null, 2) }}</pre>
      </section>
    </div>
    <LogPanel v-if="task" title="gcloud execution log" :url="task.eventUrl" />
  </section>
</template>
