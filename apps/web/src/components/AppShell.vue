<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useRoute } from 'vue-router';
import { post, type Service } from '../api';
import { useInfraStore } from '../stores/infra';

const route = useRoute();
const infra = useInfraStore();
const menuCollapsed = ref(false);
const title = computed(() => String(route.meta.title ?? 'Local Infra'));
const serviceIdForRoute = computed(() =>
  route.name === 'service'
    ? String(route.params.serviceId ?? '')
    : route.name === 'mysql'
      ? 'redash'
      : String(route.name ?? '')
);
const activeService = computed(
  () => infra.services.find((service) => service.id === serviceIdForRoute.value) as Service | undefined
);
const navigation = [
  { to: '/', label: 'Overview', icon: '⌂' },
  { to: '/mysql', label: 'MySQL', icon: 'DB' },
  { to: '/gcloud', label: 'gcloud CLI', icon: 'GC' },
  { to: '/datastore', label: 'Datastore', icon: 'DS' },
  { to: '/kafka', label: 'Kafka', icon: 'KF' },
  { to: '/kafka-ui', label: 'Kafka UI', icon: 'UI' },
  { to: '/spanner', label: 'Spanner', icon: 'SP' },
  { to: '/docker', label: 'Docker Tools', icon: 'DK' },
  { to: '/app-services', label: 'App Services', icon: 'AS' },
  { to: '/tasks', label: 'Task History', icon: '↻' },
  { to: '/system', label: 'System', icon: '◫' },
];

function toggleMenu() {
  menuCollapsed.value = !menuCollapsed.value;
}

async function lifecycle(action: 'start' | 'stop' | 'restart') {
  if (!activeService.value || activeService.value.runtimeMode !== 'daemon') return;
  try {
    await post(`/services/${activeService.value.id}/${action}`);
    ElMessage.success(`${activeService.value.label}: ${action} started`);
    window.setTimeout(infra.refresh, 500);
  } catch (cause: unknown) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Action failed');
  }
}

onMounted(infra.refresh);
</script>

<template>
  <div class="app-shell" :class="{ 'menu-collapsed': menuCollapsed }">
    <aside class="sidebar">
      <div class="brand">
        <b>LI</b>
        <div class="brand-text"><strong>Local Infra</strong><small>Coder Control Center</small></div>
      </div>
      <div class="nav-label">Workspace</div>
      <RouterLink v-for="item in navigation" :key="item.to" :to="item.to" class="nav-button"
        ><i>{{ item.icon }}</i
        ><span class="nav-text">{{ item.label }}</span></RouterLink
      >
      <div class="sidebar-note">
        <strong>Compose project</strong><br />configured from environment<br />
        <span>{{ infra.services.length }} services · internal only</span>
      </div>
      <div class="sidebar-controls">
        <button type="button" :title="menuCollapsed ? 'Show menu' : 'Hide menu'" @click="toggleMenu">
          <span aria-hidden="true">{{ menuCollapsed ? '☰' : '‹' }}</span>
          <span v-if="!menuCollapsed">Hide menu</span>
        </button>
      </div>
    </aside>
    <main class="main">
      <header class="topbar">
        <div>
          <h1>{{ title }}</h1>
          <p>Docker Compose project local-infra trong Coder Workspace</p>
        </div>
        <div class="topbar-actions">
          <span v-if="activeService" class="status" :class="activeService.status">
            {{ activeService.runtimeMode === 'one_off' ? 'on demand' : activeService.status }}
          </span>
          <div v-if="activeService?.runtimeMode === 'daemon'" class="service-actions">
            <el-button size="small" type="success" plain @click="lifecycle('start')">Start</el-button
            ><el-button size="small" type="warning" plain @click="lifecycle('restart')">Restart</el-button
            ><el-button size="small" type="danger" plain @click="lifecycle('stop')">Stop</el-button
            ><el-button size="small" @click="infra.refresh">Refresh</el-button>
          </div>
          <div class="workspace-badge" :class="{ disconnected: !infra.connected }">
            <span></span>{{ infra.connected ? 'coder-workspace · connected' : 'backend · disconnected' }}
          </div>
        </div>
      </header>
      <el-alert
        v-if="infra.error"
        :title="infra.error"
        type="error"
        show-icon
        :closable="false"
        style="margin-bottom: 16px"
      /><slot />
    </main>
  </div>
</template>

<style scoped>
.nav-button.router-link-active {
  background: #142139;
  border-color: #2d405e;
  color: white;
}
.nav-button.router-link-active i {
  background: #2459c4;
}
.sidebar-controls {
  display: flex;
  margin-top: auto;
  padding: 16px 6px 2px;
  border-top: 1px solid var(--line);
}
:global(.topbar-actions),
:global(.service-actions) {
  display: flex;
  align-items: center;
  gap: 8px;
}
:global(.topbar-actions) {
  justify-content: flex-end;
  flex-wrap: wrap;
}
:global(.sidebar) {
  display: flex;
  flex-direction: column;
}
.sidebar-controls button {
  display: inline-flex;
  width: 100%;
  min-height: 36px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid #314766;
  border-radius: 9px;
  background: linear-gradient(135deg, #172a45, #132138);
  color: #d9e7fb;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition:
    background 160ms ease,
    border-color 160ms ease,
    transform 160ms ease;
}
.sidebar-controls button:hover {
  border-color: #4c77b6;
  background: linear-gradient(135deg, #1d3c65, #172d4c);
  transform: translateY(-1px);
}
:global(.app-shell.menu-collapsed) {
  grid-template-columns: 56px minmax(0, 1fr);
}
:global(.app-shell.menu-collapsed .sidebar) {
  padding: 10px 8px;
}
:global(.app-shell.menu-collapsed .brand-text),
:global(.app-shell.menu-collapsed .brand),
:global(.app-shell.menu-collapsed .nav-label),
:global(.app-shell.menu-collapsed .nav-text),
:global(.app-shell.menu-collapsed .sidebar-note) {
  display: none;
}
:global(.app-shell.menu-collapsed .nav-button) {
  justify-content: center;
  padding: 9px 0;
}
:global(.app-shell.menu-collapsed .nav-button i) {
  width: 30px;
  height: 30px;
  font-size: 10px;
}
:global(.app-shell.menu-collapsed .sidebar-controls) {
  padding: 0;
  border: 0;
}
</style>
