<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, post } from '../api';
import LogPanel from '../components/LogPanel.vue';
import PanelControls from '../components/PanelControls.vue';

type Command = {
  id: 'containers' | 'images' | 'networks' | 'volumes' | 'compose-ps' | 'compose-services';
  label: string;
};
type Task = { taskId: string; eventUrl: string; status: string };
const commands = ref<Command[]>([]);
const commandId = ref<Command['id']>('containers');
const task = ref<Task | null>(null);
const running = ref(false);
const fail = (cause: unknown) => ElMessage.error(cause instanceof Error ? cause.message : 'Docker command failed');
async function load() {
  try {
    commands.value = await api<Command[]>('/docker/commands');
    commandId.value =
      commands.value.find((item) => item.id === commandId.value)?.id ?? commands.value[0]?.id ?? 'containers';
  } catch (cause) {
    fail(cause);
  }
}
async function run() {
  running.value = true;
  try {
    task.value = await post<Task>('/docker/tasks', { commandId: commandId.value });
    ElMessage.success('Docker command started');
  } catch (cause) {
    fail(cause);
  } finally {
    running.value = false;
  }
}
onMounted(load);
</script>
<template>
  <section>
    <div class="section-title">
      <div>
        <h2>Docker Tools</h2>
        <span>Chạy các lệnh Docker đã được duyệt; kết quả hiển thị trực tiếp bên dưới.</span>
      </div>
    </div>
    <section class="panel">
      <header class="panel-header">
        <div><strong>Command terminal</strong><small>Không cho phép shell command tùy ý</small></div>
        <PanelControls />
      </header>
      <div class="panel-body docker-command-form">
        <el-select v-model="commandId"
          ><el-option
            v-for="command in commands"
            :key="command.id"
            :label="command.label"
            :value="command.id" /></el-select
        ><el-button type="primary" :loading="running" @click="run">Run command</el-button>
      </div>
    </section>
    <LogPanel v-if="task" title="Docker command output" :url="task.eventUrl" />
    <section v-else class="panel">
      <header class="panel-header"><strong>Docker command output</strong><PanelControls /></header>
      <div class="panel-body muted-copy">Chọn một lệnh để xem stdout, stderr và trạng thái task tại đây.</div>
    </section>
  </section>
</template>

<style scoped>
.docker-command-form {
  display: flex;
  gap: 10px;
  align-items: center;
}
.docker-command-form .el-select {
  width: min(420px, 100%);
}
.muted-copy {
  color: var(--muted);
}
</style>
