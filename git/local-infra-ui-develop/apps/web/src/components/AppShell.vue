<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useDisplay } from 'vuetify';
import { useRoute } from 'vue-router';
import { post, type Service } from '../api';
import { useInfraStore } from '../stores/infra';
import { acceptDialog, cancelDialog, dialogState, ElMessage, messageState } from '../ui';

type NavigationItem = { to: string; label: string; icon: string };

const route = useRoute();
const infra = useInfraStore();
const { mobile } = useDisplay();
const drawerOpen = ref(true);
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
const serviceStatus = computed(() =>
  activeService.value?.runtimeMode === 'one_off' ? 'on demand' : activeService.value?.status
);
const menuToggleLabel = computed(() =>
  mobile.value ? 'Close navigation' : menuCollapsed.value ? 'Expand navigation' : 'Collapse navigation'
);

const navigation: Array<{ label: string; items: NavigationItem[] }> = [
  {
    label: 'Workspace',
    items: [
      { to: '/', label: 'Overview', icon: 'mdi-view-dashboard-outline' },
      { to: '/app-services', label: 'App Services', icon: 'mdi-application-braces-outline' },
      { to: '/tasks', label: 'Task History', icon: 'mdi-history' },
    ],
  },
  {
    label: 'Data & messaging',
    items: [
      { to: '/mysql', label: 'MySQL', icon: 'mdi-database-outline' },
      { to: '/datastore', label: 'Datastore', icon: 'mdi-database-search-outline' },
      { to: '/bigquery', label: 'BigQuery', icon: 'mdi-chart-box-outline' },
      { to: '/spanner', label: 'Spanner', icon: 'mdi-database-cog-outline' },
      { to: '/kafka', label: 'Kafka', icon: 'mdi-transit-connection-variant' },
      { to: '/kafka-ui', label: 'Kafka UI', icon: 'mdi-monitor-dashboard' },
    ],
  },
  {
    label: 'Tools',
    items: [
      { to: '/gcloud', label: 'gcloud CLI', icon: 'mdi-cloud-outline' },
      { to: '/keycloak', label: 'Keycloak', icon: 'mdi-shield-account-outline' },
      { to: '/mailhog', label: 'MailHog', icon: 'mdi-email-outline' },
      { to: '/jira', label: 'Jira Workspace', icon: 'mdi-jira' },
      { to: '/docker', label: 'Docker Tools', icon: 'mdi-docker' },
      { to: '/system', label: 'System', icon: 'mdi-server-outline' },
    ],
  },
];

function toggleMenu() {
  if (mobile.value) drawerOpen.value = !drawerOpen.value;
  else menuCollapsed.value = !menuCollapsed.value;
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

watch(
  mobile,
  (isMobile) => {
    drawerOpen.value = !isMobile;
  },
  { immediate: true }
);
watch(
  () => route.fullPath,
  () => {
    if (mobile.value) drawerOpen.value = false;
  }
);
onMounted(infra.refresh);
</script>

<template>
  <v-app class="app-shell">
    <v-navigation-drawer
      v-model="drawerOpen"
      class="sidebar"
      :rail="!mobile && menuCollapsed"
      :temporary="mobile"
      :permanent="!mobile"
      :width="264"
      :rail-width="72"
    >
      <div class="brand" :class="{ compact: menuCollapsed && !mobile }">
        <div class="brand-mark"><v-icon icon="mdi-layers-triple-outline" size="22" /></div>
        <div v-if="mobile || !menuCollapsed" class="brand-copy">
          <strong>Local Infra</strong>
          <span>Control Center</span>
        </div>
      </div>

      <v-list class="navigation" nav density="comfortable">
        <template v-for="group in navigation" :key="group.label">
          <v-list-subheader v-if="mobile || !menuCollapsed">{{ group.label }}</v-list-subheader>
          <v-list-item
            v-for="item in group.items"
            :key="item.to"
            :to="item.to"
            :title="item.label"
            :prepend-icon="item.icon"
            rounded="lg"
            color="primary"
          />
        </template>
      </v-list>

      <template #append>
        <div class="drawer-footer">
          <v-btn
            class="collapse-menu-button"
            block
            variant="text"
            :icon="mobile ? 'mdi-close' : menuCollapsed ? 'mdi-chevron-right' : 'mdi-chevron-left'"
            :title="menuToggleLabel"
            :aria-label="menuToggleLabel"
            @click="toggleMenu"
          />
        </div>
      </template>
    </v-navigation-drawer>

    <v-app-bar class="topbar" flat height="72">
      <v-app-bar-nav-icon v-if="mobile" aria-label="Open navigation" @click="toggleMenu" />
      <v-app-bar-title>
        <span class="page-title">{{ title }}</span>
      </v-app-bar-title>
      <div class="topbar-actions">
        <v-chip
          v-if="activeService"
          size="small"
          variant="tonal"
          :color="serviceStatus === 'running' || serviceStatus === 'healthy' ? 'success' : 'warning'"
          prepend-icon="mdi-circle-small"
        >
          {{ serviceStatus }}
        </v-chip>
        <div v-if="activeService?.runtimeMode === 'daemon'" class="service-actions">
          <v-btn size="small" color="success" icon="mdi-play" title="Start" @click="lifecycle('start')" />
          <v-btn size="small" color="warning" icon="mdi-restart" title="Restart" @click="lifecycle('restart')" />
          <v-btn size="small" color="error" icon="mdi-stop" title="Stop" @click="lifecycle('stop')" />
          <v-btn size="small" icon="mdi-refresh" title="Refresh" @click="infra.refresh" />
        </div>
        <div id="topbar-page-actions"></div>
        <v-chip
          class="connection-chip"
          size="small"
          variant="tonal"
          :color="infra.connected ? 'success' : 'error'"
          :prepend-icon="infra.connected ? 'mdi-lan-connect' : 'mdi-lan-disconnect'"
        >
          {{ infra.connected ? 'Connected' : 'Disconnected' }}
        </v-chip>
      </div>
    </v-app-bar>

    <v-main>
      <main class="main-content">
        <v-alert v-if="infra.error" class="mb-4" :text="infra.error" type="error" variant="tonal" closable />
        <slot />
      </main>
    </v-main>

    <v-snackbar v-model="messageState.open" :color="messageState.type" location="top right" :timeout="3200">
      {{ messageState.text }}
      <template #actions>
        <v-btn icon="mdi-close" variant="text" @click="messageState.open = false" />
      </template>
    </v-snackbar>

    <v-dialog v-model="dialogState.open" max-width="480" persistent>
      <v-card class="confirmation-dialog" rounded="xl">
        <v-card-title>{{ dialogState.title }}</v-card-title>
        <v-card-text>
          <p>{{ dialogState.message }}</p>
          <v-text-field
            v-if="dialogState.kind === 'prompt'"
            v-model="dialogState.value"
            autofocus
            :placeholder="dialogState.placeholder"
            :error-messages="dialogState.error"
            @keyup.enter="acceptDialog"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="cancelDialog">Cancel</v-btn>
          <v-btn color="primary" variant="flat" @click="acceptDialog">
            {{ dialogState.kind === 'prompt' ? 'Save' : 'Confirm' }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-app>
</template>

<style scoped>
.sidebar {
  border-right-color: var(--line) !important;
  background: #091424 !important;
}
.brand {
  display: flex;
  height: 72px;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
}
.brand.compact {
  justify-content: center;
  padding-inline: 8px;
}
.brand-mark {
  display: grid;
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  place-items: center;
  border-radius: 13px;
  background: linear-gradient(145deg, #6ea8fe, #806df5);
  color: #fff;
  box-shadow: 0 8px 24px rgb(81 121 234 / 28%);
}
.brand-copy {
  display: grid;
  gap: 1px;
  min-width: 0;
}
.brand-copy strong {
  font-size: 15px;
  letter-spacing: -0.01em;
}
.brand-copy span {
  color: var(--muted);
  font-size: 11px;
}
.navigation {
  padding: 4px 10px 14px;
}
.navigation :deep(.v-list-subheader) {
  min-height: 34px;
  padding-inline: 12px;
  color: #70829b;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.11em;
  text-transform: uppercase;
}
.navigation :deep(.v-list-item) {
  min-height: 42px;
  margin-bottom: 3px;
  color: #aebdd0;
}
.navigation :deep(.v-list-item--active) {
  background: linear-gradient(90deg, rgb(74 126 218 / 24%), rgb(83 96 180 / 11%));
  color: #fff;
}
.drawer-footer {
  display: flex;
  justify-content: center;
  padding: 10px;
  border-top: 1px solid var(--line);
}
.collapse-menu-button {
  width: 38px;
  min-width: 38px;
}
.topbar {
  border-bottom: 1px solid var(--line) !important;
  background: rgb(7 16 29 / 88%) !important;
  backdrop-filter: blur(16px);
}
.page-title {
  font-size: 20px;
  font-weight: 750;
  letter-spacing: -0.025em;
}
.topbar-actions,
.service-actions,
:global(.jira-topbar-btns) {
  display: flex;
  align-items: center;
  gap: 7px;
}
.topbar-actions {
  min-width: 0;
  padding-right: 20px;
}
.connection-chip {
  font-weight: 700;
}
.main-content {
  width: min(100%, 1680px);
  min-height: calc(100vh - 72px);
  margin-inline: auto;
  padding: 24px 28px 48px;
}
.confirmation-dialog p {
  margin: 0 0 18px;
  color: var(--muted);
  line-height: 1.6;
}
@media (max-width: 960px) {
  .main-content {
    padding: 18px 16px 36px;
  }
  .topbar-actions {
    padding-right: 12px;
  }
  .service-actions,
  .connection-chip {
    display: none;
  }
}
@media (max-width: 600px) {
  #topbar-page-actions {
    display: none;
  }
  .page-title {
    font-size: 17px;
  }
}
</style>
