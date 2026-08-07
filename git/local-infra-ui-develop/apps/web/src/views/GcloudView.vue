<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from '../ui';
import { api, post } from '../api';
import LogPanel from '../components/LogPanel.vue';
import PanelControls from '../components/PanelControls.vue';

type Action = { id: 'version' | 'config-list' | 'configurations' | 'auth-list'; label: string };
type Task = { taskId: string; eventUrl: string; status: string };
const actions = ref<Action[]>([]);
const actionId = ref<Action['id']>('config-list');
const project = ref('');
const task = ref<Task | null>(null);
const logTail = ref(100);
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
          <div><strong>Command catalog</strong><small>Approved commands only</small></div>
          <PanelControls />
        </header>
        <div class="panel-body">
          <v-select v-model="actionId" :items="actions" item-title="label" item-value="id" />
          <v-text-field v-model="project" class="mt-3" label="Project override" />
          <div class="toolbar">
            <v-btn color="primary" variant="flat" prepend-icon="mdi-play" @click="run">Run action</v-btn>
            <v-btn color="error" :disabled="!task" prepend-icon="mdi-stop" @click="cancel">Cancel</v-btn>
          </div>
        </div>
      </section>
      <section class="panel">
        <header class="panel-header"><strong>Task detail</strong><PanelControls /></header>
        <pre class="raw">{{ JSON.stringify(task ?? { status: 'Ready' }, null, 2) }}</pre>
      </section>
    </div>
    <LogPanel v-if="task" v-model:tail="logTail" title="gcloud execution log" :url="task.eventUrl" />
  </section>
</template>
