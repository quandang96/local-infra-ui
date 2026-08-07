<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from '../ui';
import { api, del, post } from '../api';
import LogPanel from '../components/LogPanel.vue';
import PanelControls from '../components/PanelControls.vue';

type Runtime = 'go' | 'node' | 'vue';
type ManagedService = {
  id: string;
  name: string;
  runtime: Runtime;
  workingDir: string;
  env: Record<string, string>;
  command: string;
  status: 'running' | 'stopped';
  startedAt: string | null;
};

const rows = ref<ManagedService[]>([]);
const selectedId = ref('');
const search = ref('');
const saving = ref(false);
const adding = ref(false);
const addServiceVisible = ref(false);
const logTail = ref(100);
const blankForm = () => ({ name: '', runtime: 'go' as Runtime, workingDir: '', envText: '' });
const form = ref(blankForm());
const newService = ref(blankForm());
const selected = computed(() => rows.value.find((service) => service.id === selectedId.value));
const testUrl = computed(() => (selected.value?.env.PORT ? `http://localhost:${selected.value.env.PORT}` : null));
const filteredRows = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return rows.value;
  return rows.value.filter((service) =>
    [service.name, service.runtime, service.workingDir, service.status].some((value) =>
      value.toLowerCase().includes(query)
    )
  );
});

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : 'Service request failed');
const envToText = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
function envFromText(value: string) {
  const env: Record<string, string> = {};
  for (const rawLine of value.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) throw new Error(`Invalid environment line: ${rawLine}`);
    const key = line.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
    env[key] = line.slice(index + 1);
  }
  return env;
}
async function load(preferredId?: string) {
  try {
    rows.value = (await api<{ rows: ManagedService[] }>('/app-services')).rows;
    const next = preferredId ?? selectedId.value;
    if (next && rows.value.some((service) => service.id === next)) select(next);
    else if (rows.value[0]) select(rows.value[0].id);
    else {
      selectedId.value = '';
      form.value = blankForm();
    }
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  }
}
function select(id: string) {
  selectedId.value = id;
  const service = rows.value.find((item) => item.id === id);
  if (!service) return;
  form.value = {
    name: service.name,
    runtime: service.runtime,
    workingDir: service.workingDir,
    envText: envToText(service.env),
  };
}
function create() {
  newService.value = blankForm();
  addServiceVisible.value = true;
}
async function save() {
  if (!selected.value) return;
  saving.value = true;
  try {
    const body = {
      name: form.value.name,
      runtime: form.value.runtime,
      workingDir: form.value.workingDir,
      env: envFromText(form.value.envText),
    };
    const saved = await api<ManagedService>(`/app-services/${selectedId.value}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    ElMessage.success('Service configuration saved');
    await load(saved.id);
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  } finally {
    saving.value = false;
  }
}
async function addService() {
  adding.value = true;
  try {
    const service = await post<ManagedService>('/app-services', {
      name: newService.value.name,
      runtime: newService.value.runtime,
      workingDir: newService.value.workingDir,
      env: envFromText(newService.value.envText),
    });
    addServiceVisible.value = false;
    ElMessage.success('Service created');
    await load(service.id);
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  } finally {
    adding.value = false;
  }
}
async function lifecycle(action: 'start' | 'stop' | 'restart') {
  if (!selected.value) return;
  try {
    await post(`/app-services/${selected.value.id}/${action}`);
    ElMessage.success(`${selected.value.name}: ${action} requested`);
    await load(selected.value.id);
  } catch (cause) {
    ElMessage.error(errorMessage(cause));
  }
}
async function remove() {
  if (!selected.value) return;
  try {
    const service = selected.value;
    await ElMessageBox.confirm(`Remove ${service.name}?`, 'Remove service', { type: 'warning' });
    await del(`/app-services/${service.id}`);
    ElMessage.success('Service removed');
    await load();
  } catch {
    /* confirmation cancelled */
  }
}

onMounted(load);
</script>

<template>
  <section>
    <div class="workspace service-manager">
      <section class="panel">
        <header class="panel-header">
          <strong>Services</strong>
          <div class="panel-actions">
            <v-btn color="primary" variant="flat" prepend-icon="mdi-plus" @click="create">Add service</v-btn>
            <PanelControls />
          </div>
        </header>
        <div class="panel-body service-list">
          <el-input v-model="search" clearable placeholder="Search services" />
          <button
            v-for="service in filteredRows"
            :key="service.id"
            type="button"
            :class="{ active: selectedId === service.id }"
            @click="select(service.id)"
          >
            <span
              ><strong>{{ service.name }}</strong
              ><small>{{ service.runtime }} · {{ service.command }}</small></span
            >
            <span class="status" :class="service.status">{{ service.status }}</span>
          </button>
          <p v-if="!filteredRows.length" class="empty-state">No services found.</p>
        </div>
      </section>
      <section class="panel">
        <header class="panel-header">
          <div class="service-detail-title">
            <strong>{{ selected ? selected.name : 'Select a service' }}</strong>
            <small v-if="selected">{{ selected.command }}</small>
          </div>
          <PanelControls />
        </header>
        <div class="panel-body service-form">
          <el-form label-position="top">
            <el-form-item label="Service name"
              ><el-input v-model="form.name" placeholder="Payments API"
            /></el-form-item>
            <el-form-item label="Runtime">
              <el-radio-group v-model="form.runtime">
                <el-radio-button value="go">Go · make run</el-radio-button>
                <el-radio-button value="node">Node · npm run dev</el-radio-button>
                <el-radio-button value="vue">Vue · npm run dev</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="Working directory (relative to workspace)">
              <el-input v-model="form.workingDir" placeholder="managed-services/go-hello" />
            </el-form-item>
            <el-form-item label="Environment variables (KEY=value, one per line)">
              <el-input v-model="form.envText" type="textarea" :rows="8" placeholder="PORT=8090\nLOG_LEVEL=debug" />
            </el-form-item>
          </el-form>
          <div class="toolbar">
            <v-btn
              color="primary"
              variant="flat"
              prepend-icon="mdi-content-save-outline"
              :loading="saving"
              :disabled="!selected"
              @click="save"
              >Save</v-btn
            >
            <template v-if="selected">
              <v-btn color="success" prepend-icon="mdi-play" @click="lifecycle('start')">Start</v-btn>
              <v-btn color="warning" prepend-icon="mdi-restart" @click="lifecycle('restart')">Restart</v-btn>
              <v-btn color="error" prepend-icon="mdi-stop" @click="lifecycle('stop')">Stop</v-btn>
              <v-btn v-if="testUrl" :href="testUrl" target="_blank" append-icon="mdi-open-in-new">Open</v-btn>
              <v-btn color="error" variant="text" prepend-icon="mdi-delete-outline" @click="remove">Remove</v-btn>
            </template>
          </div>
        </div>
      </section>
    </div>
    <LogPanel
      v-if="selected"
      :key="selected.id"
      v-model:tail="logTail"
      :title="`${selected.name} logs`"
      :url="`/api/app-services/${selected.id}/logs/events`"
    />
    <el-dialog v-model="addServiceVisible" title="Add service" width="min(620px, 92vw)" destroy-on-close>
      <el-form label-position="top">
        <el-form-item label="Service name"
          ><el-input v-model="newService.name" placeholder="Payments API"
        /></el-form-item>
        <el-form-item label="Runtime">
          <el-radio-group v-model="newService.runtime">
            <el-radio-button value="go">Go · make run</el-radio-button>
            <el-radio-button value="node">Node · npm run dev</el-radio-button>
            <el-radio-button value="vue">Vue · npm run dev</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="Working directory (relative to workspace)">
          <el-input v-model="newService.workingDir" placeholder="managed-services/go-hello" />
        </el-form-item>
        <el-form-item label="Environment variables (KEY=value, one per line)">
          <el-input v-model="newService.envText" type="textarea" :rows="6" placeholder="PORT=8090\nLOG_LEVEL=debug" />
        </el-form-item>
      </el-form>
      <template #footer>
        <v-btn variant="text" @click="addServiceVisible = false">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :loading="adding" @click="addService">Add service</v-btn>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.service-manager {
  grid-template-columns: minmax(260px, 0.55fr) minmax(0, 1.45fr);
}
.service-list {
  display: grid;
  gap: 8px;
}
.service-list :deep(.el-input) {
  margin-bottom: 4px;
}
.service-list button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 12px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: #101b2d;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.service-list button:hover,
.service-list button.active {
  border-color: #3c608f;
  background: #172a45;
}
.service-list strong,
.service-list small {
  display: block;
}
.service-list small {
  margin-top: 3px;
  color: var(--muted);
  font-size: 11px;
}
.service-form :deep(.el-radio-group) {
  display: flex;
  flex-wrap: wrap;
}
:deep(.add-service-button) {
  color: #fff;
}
.panel-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
:global(.service-manager:has(> .panel:last-child.panel-collapsed)) {
  grid-template-columns: minmax(260px, 0.55fr) minmax(0, 1.45fr) !important;
}
:global(.service-manager > .panel:last-child.panel-collapsed .panel-header) {
  justify-content: space-between;
  min-height: 58px;
  padding: 12px 16px;
}
:global(.service-manager > .panel:last-child.panel-collapsed .panel-header .service-detail-title) {
  display: block !important;
  min-width: 0;
}
@media (max-width: 1180px) {
  .service-manager {
    grid-template-columns: 1fr;
  }
}
</style>
