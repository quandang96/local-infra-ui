<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDisplay, useTheme } from 'vuetify';
import { useRoute, useRouter } from 'vue-router';
import { api, post, serviceStatusClass, serviceStatusLabel, type Service } from '../api';
import { useInfraStore } from '../stores/infra';
import { acceptDialog, cancelDialog, dialogState, ElMessage, messageState } from '../ui';

type NavigationItem = { to: string; label: string; icon: string };

const route = useRoute();
const router = useRouter();
const infra = useInfraStore();
const { mobile } = useDisplay();
const theme = useTheme();
const drawerOpen = ref(true);
const menuCollapsed = ref(false);
const colorMode = ref<'dark' | 'light'>('dark');
const notificationMenu = ref(false);
const notifications = ref<
  Array<{
    id: number;
    pageTitle: string;
    spaceName: string;
    changedByName: string;
    changedAt: string;
    isRead: boolean;
  }>
>([]);
const unreadNotifications = ref(0);
let notificationTimer: number | undefined;
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
const serviceStatus = computed(() => activeService.value?.status);
const serviceStatusText = computed(() =>
  activeService.value?.runtimeMode === 'one_off' ? 'On demand' : serviceStatusLabel(serviceStatus.value)
);
const serviceStatusColor = computed(() => {
  if (activeService.value?.runtimeMode === 'one_off') return 'info';
  const status = serviceStatusClass(serviceStatus.value);
  if (status === 'healthy' || status === 'running') return 'success';
  if (status === 'starting' || status === 'not_created' || status === 'tool') return 'warning';
  return 'error';
});
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
      { to: '/confluence-monitor', label: 'Confluence Monitor', icon: 'mdi-bell-ring-outline' },
      { to: '/notes', label: 'Notes', icon: 'mdi-notebook-outline' },
      { to: '/docker', label: 'Docker Tools', icon: 'mdi-docker' },
      { to: '/system', label: 'System', icon: 'mdi-server-outline' },
    ],
  },
];

function toggleMenu() {
  if (mobile.value) drawerOpen.value = !drawerOpen.value;
  else menuCollapsed.value = !menuCollapsed.value;
}

function setColorMode(mode: 'dark' | 'light') {
  colorMode.value = mode;
  document.documentElement.dataset.theme = mode;
  document.documentElement.classList.toggle('dark', mode === 'dark');
  theme.global.name.value = mode === 'dark' ? 'localInfraDark' : 'localInfraLight';
  window.localStorage.setItem('local-infra-color-mode', mode);
}

function toggleColorMode() {
  setColorMode(colorMode.value === 'dark' ? 'light' : 'dark');
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

async function loadNotifications() {
  try {
    const result = await api<{ rows: typeof notifications.value; unread: number }>(
      '/confluence-monitor/notifications?limit=8'
    );
    notifications.value = result.rows;
    unreadNotifications.value = result.unread;
  } catch {
    notifications.value = [];
    unreadNotifications.value = 0;
  }
}

function notificationDate(value: string) {
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

async function openNotification(id: number) {
  notificationMenu.value = false;
  await router.push({ path: '/confluence-monitor', query: { change: String(id) } });
}

async function markAllNotificationsRead() {
  try {
    await api('/confluence-monitor/changes/read-all', { method: 'PATCH' });
    notifications.value = [];
    unreadNotifications.value = 0;
    window.dispatchEvent(new CustomEvent('confluence-notifications-refresh'));
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không cập nhật được thông báo');
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
onMounted(() => {
  const savedMode = window.localStorage.getItem('local-infra-color-mode');
  setColorMode(savedMode === 'light' ? 'light' : 'dark');
  infra.refresh();
  void loadNotifications();
  window.addEventListener('confluence-notifications-refresh', loadNotifications);
  notificationTimer = window.setInterval(loadNotifications, 60_000);
});
onBeforeUnmount(() => {
  window.removeEventListener('confluence-notifications-refresh', loadNotifications);
  if (notificationTimer) window.clearInterval(notificationTimer);
});
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
      <div id="topbar-page-tabs"></div>
      <div class="topbar-actions">
        <v-chip
          v-if="activeService"
          size="small"
          variant="tonal"
          :color="serviceStatusColor"
          prepend-icon="mdi-circle-small"
        >
          {{ serviceStatusText }}
        </v-chip>
        <div v-if="activeService?.runtimeMode === 'daemon'" class="service-actions">
          <v-btn size="small" color="success" icon="mdi-play" title="Start" @click="lifecycle('start')" />
          <v-btn size="small" color="warning" icon="mdi-restart" title="Restart" @click="lifecycle('restart')" />
          <v-btn size="small" color="error" icon="mdi-stop" title="Stop" @click="lifecycle('stop')" />
          <v-btn size="small" icon="mdi-refresh" title="Refresh" @click="infra.refresh" />
        </div>
        <v-menu v-model="notificationMenu" location="bottom end" :offset="10" :close-on-content-click="false">
          <template #activator="{ props }">
            <v-badge
              :model-value="unreadNotifications > 0"
              :content="unreadNotifications > 99 ? '99+' : unreadNotifications"
              color="error"
              floating
            >
              <v-btn
                v-bind="props"
                class="notification-button"
                size="small"
                icon="mdi-bell-outline"
                title="Thông báo Confluence"
                aria-label="Thông báo Confluence"
              />
            </v-badge>
          </template>
          <v-card class="notification-popover" rounded="xl" width="380" max-width="calc(100vw - 24px)">
            <div class="notification-head">
              <div>
                <strong>Thông báo</strong><span>{{ unreadNotifications }} chưa đọc</span>
              </div>
              <v-btn
                v-if="unreadNotifications"
                size="small"
                variant="text"
                color="primary"
                @click="markAllNotificationsRead"
                >Áp dụng tất cả</v-btn
              >
            </div>
            <div v-if="notifications.length" class="notification-list">
              <button
                v-for="notification in notifications"
                :key="notification.id"
                :class="['notification-item', { unread: !notification.isRead }]"
                @click="openNotification(notification.id)"
              >
                <span class="notification-file"><v-icon icon="mdi-file-document-edit-outline" size="18" /></span>
                <span class="notification-copy">
                  <b>{{ notification.pageTitle }}</b>
                  <span>{{ notification.changedByName }} đã cập nhật · {{ notification.spaceName }}</span>
                  <small>{{ notificationDate(notification.changedAt) }}</small>
                </span>
                <i v-if="!notification.isRead" />
              </button>
            </div>
            <div v-else class="notification-empty">
              <v-icon icon="mdi-bell-check-outline" size="30" />
              <strong>Chưa có thông báo</strong>
              <span>Thay đổi Confluence sẽ xuất hiện tại đây.</span>
            </div>
            <v-btn block variant="text" color="primary" to="/confluence-monitor" @click="notificationMenu = false">
              Xem tất cả thay đổi
            </v-btn>
          </v-card>
        </v-menu>
        <v-btn
          class="theme-toggle"
          size="small"
          :icon="colorMode === 'dark' ? 'mdi-weather-sunny' : 'mdi-weather-night'"
          :title="colorMode === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'"
          :aria-label="colorMode === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'"
          @click="toggleColorMode"
        />
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
  background: var(--side) !important;
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
  color: var(--nav-muted);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.11em;
  text-transform: uppercase;
}
.navigation :deep(.v-list-item) {
  min-height: 42px;
  margin-bottom: 3px;
  color: var(--nav-text);
}
.navigation :deep(.v-list-item--active) {
  background: var(--nav-active-bg);
  color: var(--nav-active-text);
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
  background: var(--topbar) !important;
  backdrop-filter: blur(16px);
}
.page-title {
  display: block;
  overflow: hidden;
  font-size: 20px;
  font-weight: 750;
  letter-spacing: -0.025em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.topbar :deep(.v-toolbar-title) {
  flex: 0 1 auto;
  min-width: 0;
}
.topbar :deep(.v-toolbar__content) {
  display: flex;
  gap: 8px;
  overflow: hidden;
}
#topbar-page-tabs {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
}
.topbar-actions,
.service-actions,
:global(.jira-topbar-btns) {
  display: flex;
  align-items: center;
  gap: 7px;
}
:global(.jira-topbar-tabs) {
  display: flex;
  align-items: center;
  gap: 2px;
  width: 100%;
  max-width: none;
  overflow-x: auto;
}
:global(.jira-topbar-tabs .v-btn) {
  min-width: auto;
  min-height: 36px !important;
  padding-inline: 10px !important;
  color: var(--muted);
  font-size: 12px !important;
  white-space: nowrap;
}
:global(.jira-topbar-tab-icon) {
  display: inline-grid;
  width: 21px;
  height: 21px;
  margin-right: 5px;
  place-items: center;
  border-radius: 6px;
  background: var(--soft);
  font-size: 12px;
  font-weight: 800;
}
:global(.jira-topbar-tabs .v-btn.is-active) {
  background: var(--control-hover);
  color: var(--el-color-primary);
}
:global(.jira-topbar-tabs .v-btn.is-active .jira-topbar-tab-icon) {
  background: var(--el-color-primary);
  color: #fff;
}
.topbar-actions {
  flex: 0 0 auto;
  min-width: 0;
  padding-right: 20px;
  white-space: nowrap;
}
.connection-chip {
  font-weight: 700;
}
.notification-button {
  color: var(--muted);
}
.notification-popover {
  overflow: hidden;
  border: 1px solid var(--line);
  background: var(--panel-strong) !important;
  box-shadow: 0 22px 60px rgb(0 0 0 / 28%) !important;
}
.notification-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 15px 16px 12px;
  border-bottom: 1px solid var(--line);
}
.notification-head > div {
  display: grid;
  gap: 2px;
}
.notification-head strong {
  color: var(--text);
  font-size: 14px;
}
.notification-head span {
  color: var(--muted);
  font-size: 10px;
}
.notification-list {
  max-height: 390px;
  overflow-y: auto;
}
.notification-item {
  display: grid;
  width: 100%;
  grid-template-columns: auto 1fr auto;
  align-items: start;
  gap: 10px;
  padding: 12px 15px;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.notification-item:hover,
.notification-item.unread {
  background: var(--control-hover);
}
.notification-file {
  display: grid;
  width: 33px;
  height: 33px;
  place-items: center;
  border-radius: 9px;
  background: rgb(37 99 235 / 13%);
  color: #3b82f6;
}
.notification-copy {
  display: grid;
  min-width: 0;
  gap: 3px;
}
.notification-copy b {
  overflow: hidden;
  color: var(--text);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.notification-copy span,
.notification-copy small {
  color: var(--muted);
  font-size: 10px;
  line-height: 1.35;
}
.notification-copy small {
  color: #568fe9;
}
.notification-item > i {
  width: 7px;
  height: 7px;
  margin-top: 5px;
  border-radius: 50%;
  background: #3b82f6;
}
.notification-empty {
  display: grid;
  justify-items: center;
  gap: 5px;
  padding: 32px 20px;
  color: var(--muted);
  text-align: center;
}
.notification-empty strong {
  color: var(--text);
  font-size: 12px;
}
.notification-empty span {
  font-size: 10px;
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
  .connection-chip,
  #topbar-page-tabs {
    display: none;
  }
}
@media (max-width: 1120px) {
  .topbar-actions,
  :global(.jira-topbar-btns) {
    gap: 4px;
  }
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
