<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { post } from '../api';
import { useInfraStore } from '../stores/infra';
import PanelControls from '../components/PanelControls.vue';

const infra = useInfraStore();
const dedicatedRoutes = new Set(['mysql', 'gcloud', 'datastore', 'kafka', 'kafka-ui', 'redash', 'spanner']);
const serviceRoute = (id: string) => (dedicatedRoutes.has(id) ? `/${id}` : `/service/${id}`);
const overviewTools = [
  {
    id: 'app-services',
    label: 'App Services',
    container: 'managed processes',
    image: 'Go / Node / Vue',
    ports: ['on demand'],
    status: 'tool',
  },
  {
    id: 'docker',
    label: 'Docker Tools',
    container: 'approved commands',
    image: 'Docker CLI',
    ports: ['workspace'],
    status: 'tool',
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
        <small>CPU · workspace</small><strong>{{ infra.overview.system.cpuCores ?? '—' }} cores</strong
        ><span>Node / cgroup visibility</span>
      </article>
      <article class="metric">
        <small>Memory</small><strong>{{ fmtBytes(infra.overview.system.memory?.used) }}</strong
        ><span>{{ fmtBytes(infra.overview.system.memory?.available) }} available</span>
      </article>
      <article class="metric">
        <small>Docker disk</small><strong>{{ fmtBytes(infra.overview.system.docker?.LayersSize) }}</strong
        ><span>images and volumes</span>
      </article>
      <article class="metric">
        <small>Services</small
        ><strong>{{ infra.overview.counts.running ?? 0 }} / {{ infra.overview.counts.totalDaemons ?? 5 }}</strong
        ><span>{{ infra.overview.counts.unhealthy ?? 0 }} unhealthy</span>
      </article>
    </div>
    <div class="section-title">
      <div>
        <h2>Local services &amp; tools</h2>
        <span>Chọn service hoặc công cụ để mở workspace chuyên biệt</span>
      </div>
      <div>
        <el-button size="small" @click="bulk('compose.startAll')">Start all</el-button
        ><el-button size="small" @click="bulk('compose.restartUnhealthy')">Restart unhealthy</el-button
        ><el-button size="small" type="danger" plain @click="bulk('compose.stopAll')">Stop all</el-button
        ><el-button size="small" :loading="infra.loading" @click="infra.refresh">Refresh</el-button>
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
          <span class="status" :class="service.status">{{
            service.runtimeMode === 'one_off' ? 'on demand' : service.status
          }}</span>
        </div>
        <div class="card-meta">
          <span
            >Image <b>{{ service.image }}</b></span
          ><span
            >Ports <b>{{ service.ports.join(' / ') || '—' }}</b></span
          >
        </div></RouterLink
      >
      <RouterLink v-for="tool in overviewTools" :key="tool.id" :to="`/${tool.id}`" class="service-card">
        <div class="card-head">
          <div>
            <b>{{ tool.label }}</b
            ><small>{{ tool.container }}</small>
          </div>
          <span class="status" :class="tool.status">on demand</span>
        </div>
        <div class="card-meta">
          <span
            >Tool <b>{{ tool.image }}</b></span
          ><span
            >Scope <b>{{ tool.ports.join(' / ') }}</b></span
          >
        </div>
      </RouterLink>
    </div>
    <section class="panel">
      <header class="panel-header">
        <div><strong>Recent tasks</strong><small>Audit trail persisted in SQLite</small></div>
        <div>
          <RouterLink to="/tasks"><el-button size="small">Open history</el-button></RouterLink
          ><PanelControls />
        </div>
      </header>
      <el-table :data="infra.tasks.slice(0, 8)" stripe
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
