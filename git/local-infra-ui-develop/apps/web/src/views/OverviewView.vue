<script setup lang="ts">
import { ElMessage } from '../ui';
import { post, serviceStatusClass, serviceStatusLabel } from '../api';
import { useInfraStore } from '../stores/infra';
import PanelControls from '../components/PanelControls.vue';

const infra = useInfraStore();
const dedicatedRoutes = new Set([
  'mysql',
  'gcloud',
  'datastore',
  'kafka',
  'kafka-ui',
  'redash',
  'spanner',
  'bigquery',
  'keycloak',
  'mailhog',
]);
const serviceRoute = (id: string) => (dedicatedRoutes.has(id) ? `/${id}` : `/service/${id}`);
const overviewTools = [
  {
    id: 'app-services',
    label: 'App Services',
    container: 'managed processes',
    image: 'Go / Node / Vue',
    ports: ['on demand'],
    status: 'tool',
    icon: 'mdi-application-braces-outline',
  },
  {
    id: 'tasks',
    label: 'Task History',
    container: 'background operations',
    image: 'Task queue',
    ports: ['workspace'],
    status: 'tool',
    icon: 'mdi-history',
  },
  {
    id: 'notes',
    label: 'Notes',
    container: 'private workspace',
    image: 'Rich text notes',
    ports: ['workspace'],
    status: 'tool',
    icon: 'mdi-notebook-outline',
  },
  {
    id: 'jira',
    label: 'Jira Workspace',
    container: 'project tracking',
    image: 'Jira reports',
    ports: ['workspace'],
    status: 'tool',
    icon: 'mdi-jira',
  },
  {
    id: 'gcloud',
    label: 'gcloud CLI',
    container: 'Google Cloud tools',
    image: 'Google Cloud SDK',
    ports: ['on demand'],
    status: 'tool',
    icon: 'mdi-cloud-outline',
  },
  {
    id: 'docker',
    label: 'Docker Tools',
    container: 'approved commands',
    image: 'Docker CLI',
    ports: ['workspace'],
    status: 'tool',
    icon: 'mdi-docker',
  },
  {
    id: 'system',
    label: 'System',
    container: 'workspace diagnostics',
    image: 'Host & Docker status',
    ports: ['workspace'],
    status: 'tool',
    icon: 'mdi-server-outline',
  },
];
const fmtBytes = (value?: number) => (value == null ? '—' : `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`);
async function bulk(actionId: 'compose.startAll' | 'compose.stopAll' | 'compose.restartUnhealthy') {
  try {
    await post('/tasks', { actionId, params: {} });
    ElMessage.success('Task started');
    window.setTimeout(infra.refresh, 500);
  } catch (cause: unknown) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Action failed');
  }
}
</script>
<template>
  <section>
    <div class="metric-grid">
      <article class="metric">
        <div class="metric-icon"><v-icon icon="mdi-chip" /></div>
        <div>
          <small>CPU</small><strong>{{ infra.overview.system.cpuCores ?? '—' }} cores</strong>
        </div>
      </article>
      <article class="metric">
        <div class="metric-icon"><v-icon icon="mdi-memory" /></div>
        <div>
          <small>Memory used</small><strong>{{ fmtBytes(infra.overview.system.memory?.used) }}</strong>
        </div>
      </article>
      <article class="metric">
        <div class="metric-icon"><v-icon icon="mdi-harddisk" /></div>
        <div>
          <small>Docker disk</small><strong>{{ fmtBytes(infra.overview.system.docker?.LayersSize) }}</strong>
        </div>
      </article>
      <article class="metric">
        <div class="metric-icon"><v-icon icon="mdi-server-network" /></div>
        <div>
          <small>Services running</small>
          <strong>{{ infra.overview.counts.running ?? 0 }} / {{ infra.overview.counts.totalDaemons ?? 5 }}</strong>
        </div>
      </article>
    </div>
    <div class="section-title">
      <div>
        <h2>Services</h2>
        <span>Trạng thái hạ tầng trong workspace</span>
      </div>
      <div class="section-actions">
        <v-btn size="small" color="success" prepend-icon="mdi-play" @click="bulk('compose.startAll')">Start all</v-btn>
        <v-btn size="small" color="warning" prepend-icon="mdi-restart" @click="bulk('compose.restartUnhealthy')">
          Restart unhealthy
        </v-btn>
        <v-btn size="small" color="error" prepend-icon="mdi-stop" @click="bulk('compose.stopAll')">Stop all</v-btn>
        <v-btn size="small" icon="mdi-refresh" :loading="infra.loading" title="Refresh" @click="infra.refresh" />
      </div>
    </div>
    <div class="service-grid">
      <RouterLink
        v-for="service in infra.services"
        :key="service.id"
        :to="serviceRoute(service.id)"
        class="service-card"
        ><div class="card-head">
          <div>
            <b>{{ service.label }}</b
            ><small>{{ service.container ?? 'one-off tool' }}</small>
          </div>
          <span class="status" :class="serviceStatusClass(service.status)">{{
            service.runtimeMode === 'one_off' ? 'On demand' : serviceStatusLabel(service.status)
          }}</span>
        </div>
        <div class="card-meta">
          <span><v-icon icon="mdi-cube-outline" size="14" /> {{ service.image }}</span>
          <span><v-icon icon="mdi-lan" size="14" /> {{ service.ports.join(' / ') || 'No exposed port' }}</span>
        </div></RouterLink
      >
      <RouterLink v-for="tool in overviewTools" :key="tool.id" :to="`/${tool.id}`" class="service-card">
        <div class="card-head">
          <div>
            <b>{{ tool.label }}</b
            ><small>{{ tool.container }}</small>
          </div>
          <span class="status" :class="serviceStatusClass(tool.status)">On demand</span>
        </div>
        <div class="card-meta">
          <span><v-icon :icon="tool.icon" size="14" /> {{ tool.image }}</span>
          <span><v-icon icon="mdi-crosshairs-gps" size="14" /> {{ tool.ports.join(' / ') }}</span>
        </div>
      </RouterLink>
    </div>
    <section class="panel">
      <header class="panel-header">
        <strong>Recent tasks</strong>
        <div>
          <v-btn to="/tasks" size="small" variant="text" append-icon="mdi-arrow-right">View all</v-btn>
          <PanelControls />
        </div>
      </header>
      <el-table :data="infra.tasks.slice(0, 8)" stripe max-height="360"
        ><el-table-column prop="service_id" label="Service" /><el-table-column
          prop="action_id"
          label="Action"
          min-width="220" /><el-table-column prop="status" label="Status" /><el-table-column
          prop="created_at"
          label="Started"
          min-width="180"
      /></el-table>
    </section>
  </section>
</template>
