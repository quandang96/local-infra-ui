<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, post } from '../api';
import { ElMessage, ElMessageBox } from '../ui';

type Space = { key: string; name: string };
type PageOption = { id: string; title: string };
type PageResult = { rows: PageOption[]; nextStart: number; hasMore: boolean };
type ChangeEvent = {
  id: number;
  pageId: string;
  pageTitle: string;
  spaceKey: string;
  spaceName: string;
  previousVersion: number;
  currentVersion: number;
  changedByKey: string;
  changedByName: string;
  changedAt: string;
  versionMessage?: string;
  minorEdit: boolean;
  confluenceUrl: string;
  isRead: boolean;
};
type Rule = {
  id: string;
  spaceKey: string;
  spaceName: string;
  scopeType: 'ALL_PAGES' | 'SELECTED_PAGES';
  ignoreMinorEdit: boolean;
  enabled: boolean;
  pages: PageOption[];
};
type MonitorSettings = {
  batchEnabled: boolean;
  firstSyncTime: string;
  secondSyncTime: string;
  syncSpaceKeys: string[];
  lastSyncAt?: string;
  timezone: string;
};

const route = useRoute();
const router = useRouter();
const activeTab = ref<'changes' | 'monitoring'>('changes');
const loading = ref(false);
const syncing = ref(false);
const testing = ref(false);
const registeringWebhook = ref(false);
const savingSettings = ref(false);
const ruleDialog = ref(false);
const ruleSaving = ref(false);
const drawer = ref(false);
const selectedChange = ref<ChangeEvent | null>(null);
const changes = ref<ChangeEvent[]>([]);
const total = ref(0);
const summary = reactive({ todayChanges: 0, unread: 0, changedPages: 0, changers: 0 });
const connection = ref<Record<string, any>>({ configured: false, webhookStatus: 'inactive' });
const spaces = ref<Space[]>([]);
const rules = ref<Rule[]>([]);
const pageOptions = ref<PageOption[]>([]);
const pageLoading = ref(false);
const pageSearch = ref('');
const pageNextStart = ref(0);
const pageHasMore = ref(false);
const pageQuery = ref('');
const filterPageOptions = ref<PageOption[]>([]);
const filterPageLoading = ref(false);
const filterPageNextStart = ref(0);
const filterPageHasMore = ref(false);
const filterPageQuery = ref('');
const filters = reactive({ status: 'all', spaceKey: '', pageId: '', changedBy: '', dates: [] as string[] });
const pagination = reactive({ page: 1, limit: 20 });
const settings = reactive<MonitorSettings>({
  batchEnabled: true,
  firstSyncTime: '09:00',
  secondSyncTime: '17:00',
  syncSpaceKeys: [],
  timezone: 'Asia/Bangkok',
});
const ruleForm = reactive<{
  id?: string;
  spaceKey: string;
  scopeType: 'ALL_PAGES' | 'SELECTED_PAGES';
  pages: string[];
  ignoreMinorEdit: boolean;
  enabled: boolean;
}>({ spaceKey: '', scopeType: 'ALL_PAGES', pages: [], ignoreMinorEdit: true, enabled: true });

const monitoredSpaces = computed<Space[]>(() => {
  const source = spaces.value.length
    ? spaces.value
    : rules.value.map((rule) => ({ key: rule.spaceKey, name: rule.spaceName }));
  const keys = new Set(rules.value.filter((rule) => rule.enabled).map((rule) => rule.spaceKey));
  return source.filter((space) => keys.has(space.key));
});
const filterSpaces = computed(() => {
  const map = new Map<string, Space>();
  for (const rule of rules.value) map.set(rule.spaceKey, { key: rule.spaceKey, name: rule.spaceName });
  for (const change of changes.value) map.set(change.spaceKey, { key: change.spaceKey, name: change.spaceName });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
});
const filterChangers = computed(() => {
  const map = new Map(changes.value.map((change) => [change.changedByKey, change.changedByName]));
  return [...map].map(([key, name]) => ({ key, name }));
});
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pagination.limit)));
const selectedSpace = computed(() => spaces.value.find((space) => space.key === ruleForm.spaceKey));

function formatDate(value?: string) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatTime(value?: string) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function historyUrl(change: ChangeEvent) {
  const marker = change.confluenceUrl.indexOf('/pages/');
  const base = marker >= 0 ? change.confluenceUrl.slice(0, marker) : change.confluenceUrl.replace(/\/$/, '');
  return `${base}/pages/viewpreviousversions.action?pageId=${encodeURIComponent(change.pageId)}`;
}

async function loadChanges() {
  const params = new URLSearchParams({
    status: filters.status,
    page: String(pagination.page),
    limit: String(pagination.limit),
  });
  if (filters.spaceKey) params.set('spaceKey', filters.spaceKey);
  if (filters.pageId) params.set('pageId', filters.pageId);
  if (filters.changedBy) params.set('changedBy', filters.changedBy);
  if (filters.dates[0]) params.set('from', filters.dates[0]);
  if (filters.dates[1]) params.set('to', filters.dates[1]);
  const result = await api<{ rows: ChangeEvent[]; total: number }>(`/confluence-monitor/changes?${params}`);
  changes.value = result.rows;
  total.value = result.total;
}

async function loadSummary() {
  Object.assign(summary, await api<typeof summary>('/confluence-monitor/summary'));
}

async function loadWorkspace() {
  loading.value = true;
  try {
    const [statusResult, rulesResult, settingsResult] = await Promise.all([
      api<Record<string, any>>('/confluence-monitor/status'),
      api<{ rows: Rule[] }>('/confluence-monitor/rules'),
      api<MonitorSettings>('/confluence-monitor/settings'),
    ]);
    connection.value = statusResult;
    rules.value = rulesResult.rows;
    Object.assign(settings, settingsResult);
    await Promise.all([loadSummary(), loadChanges()]);
    if (connection.value.configured) {
      try {
        spaces.value = (await api<{ rows: Space[] }>('/confluence-monitor/spaces')).rows;
      } catch (cause) {
        ElMessage.warning(cause instanceof Error ? cause.message : 'Không tải được danh sách Space');
      }
    }
    const changeId = Number(route.query.change);
    if (Number.isInteger(changeId) && changeId > 0) await openChange(changeId);
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không tải được Confluence Monitor');
  } finally {
    loading.value = false;
  }
}

async function applyFilters() {
  pagination.page = 1;
  await loadChanges();
}

async function clearFilters() {
  Object.assign(filters, { status: 'all', spaceKey: '', pageId: '', changedBy: '', dates: [] });
  await applyFilters();
}

async function openChange(id: number) {
  try {
    selectedChange.value = await api<ChangeEvent>(`/confluence-monitor/changes/${id}`);
    drawer.value = true;
    if (String(route.query.change ?? '') !== String(id))
      await router.replace({ query: { ...route.query, change: String(id) } });
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không tải được chi tiết thay đổi');
  }
}

async function closeDrawer() {
  drawer.value = false;
  const query = { ...route.query };
  delete query.change;
  await router.replace({ query });
}

async function markRead(change = selectedChange.value) {
  if (!change || change.isRead) return;
  await api(`/confluence-monitor/changes/${change.id}/read`, { method: 'PATCH' });
  changes.value = changes.value.filter((item) => item.id !== change.id);
  total.value = Math.max(0, total.value - 1);
  await closeDrawer();
  selectedChange.value = null;
  await loadSummary();
  window.dispatchEvent(new CustomEvent('confluence-notifications-refresh'));
  ElMessage.success('Đã áp dụng version mới vào dữ liệu chính');
}

async function markAllRead() {
  await api('/confluence-monitor/changes/read-all', { method: 'PATCH' });
  changes.value = [];
  total.value = 0;
  selectedChange.value = null;
  drawer.value = false;
  await loadSummary();
  window.dispatchEvent(new CustomEvent('confluence-notifications-refresh'));
  ElMessage.success('Đã áp dụng các version chờ vào dữ liệu chính');
}

async function manualSync() {
  syncing.value = true;
  try {
    const result = await post<{ scanned: number; changed: number }>('/confluence-monitor/sync', {
      spaceKeys: settings.syncSpaceKeys,
    });
    await Promise.all([loadChanges(), loadSummary()]);
    const latest = await api<MonitorSettings>('/confluence-monitor/settings');
    Object.assign(settings, latest);
    window.dispatchEvent(new CustomEvent('confluence-notifications-refresh'));
    ElMessage.success(`Đã quét ${result.scanned} trang, ghi nhận ${result.changed} thay đổi mới`);
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Sync thất bại');
  } finally {
    syncing.value = false;
  }
}

async function testConnection() {
  testing.value = true;
  try {
    await post('/confluence-monitor/connection/test');
    connection.value = await api('/confluence-monitor/status');
    spaces.value = (await api<{ rows: Space[] }>('/confluence-monitor/spaces?refresh=true')).rows;
    ElMessage.success('Kết nối Confluence Data Center thành công');
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không thể kết nối Confluence');
  } finally {
    testing.value = false;
  }
}

async function registerWebhook() {
  registeringWebhook.value = true;
  try {
    await post('/confluence-monitor/webhook/register');
    connection.value = await api('/confluence-monitor/status');
    ElMessage.success('Webhook Confluence Monitor đã được kích hoạt');
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không đăng ký được webhook');
  } finally {
    registeringWebhook.value = false;
  }
}

function resetRuleForm(rule?: Rule) {
  Object.assign(
    ruleForm,
    rule
      ? {
          id: rule.id,
          spaceKey: rule.spaceKey,
          scopeType: rule.scopeType,
          pages: rule.pages.map((page) => page.id),
          ignoreMinorEdit: rule.ignoreMinorEdit,
          enabled: rule.enabled,
        }
      : { id: undefined, spaceKey: '', scopeType: 'ALL_PAGES', pages: [], ignoreMinorEdit: true, enabled: true }
  );
  pageOptions.value = rule?.pages ? [...rule.pages] : [];
  pageSearch.value = '';
  ruleDialog.value = true;
}

async function searchPages(query = pageSearch.value) {
  if (!ruleForm.spaceKey) return;
  pageLoading.value = true;
  pageQuery.value = query;
  try {
    const params = new URLSearchParams({ spaceKey: ruleForm.spaceKey, q: query, limit: '1000', start: '0' });
    const result = await api<PageResult>(`/confluence-monitor/pages?${params}`);
    const loaded = result.rows;
    const selected = pageOptions.value.filter((page) => ruleForm.pages.includes(page.id));
    pageOptions.value = [...new Map([...selected, ...loaded].map((page) => [page.id, page])).values()];
    pageNextStart.value = result.nextStart;
    pageHasMore.value = result.hasMore;
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không tìm được trang');
  } finally {
    pageLoading.value = false;
  }
}

async function loadMorePages() {
  if (!ruleForm.spaceKey || !pageHasMore.value || pageLoading.value) return;
  pageLoading.value = true;
  try {
    const params = new URLSearchParams({
      spaceKey: ruleForm.spaceKey,
      q: pageQuery.value,
      limit: '1000',
      start: String(pageNextStart.value),
    });
    const result = await api<PageResult>(`/confluence-monitor/pages?${params}`);
    pageOptions.value = [...new Map([...pageOptions.value, ...result.rows].map((page) => [page.id, page])).values()];
    pageNextStart.value = result.nextStart;
    pageHasMore.value = result.hasMore;
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không tải thêm được trang');
  } finally {
    pageLoading.value = false;
  }
}

async function searchFilterPages(query = '') {
  if (!filters.spaceKey) {
    filterPageOptions.value = [];
    return;
  }
  filterPageLoading.value = true;
  filterPageQuery.value = query;
  try {
    const params = new URLSearchParams({ spaceKey: filters.spaceKey, q: query, limit: '1000', start: '0' });
    const result = await api<PageResult>(`/confluence-monitor/pages?${params}`);
    filterPageOptions.value = result.rows;
    filterPageNextStart.value = result.nextStart;
    filterPageHasMore.value = result.hasMore;
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không tìm được trang');
  } finally {
    filterPageLoading.value = false;
  }
}

async function loadMoreFilterPages() {
  if (!filters.spaceKey || !filterPageHasMore.value || filterPageLoading.value) return;
  filterPageLoading.value = true;
  try {
    const params = new URLSearchParams({
      spaceKey: filters.spaceKey,
      q: filterPageQuery.value,
      limit: '1000',
      start: String(filterPageNextStart.value),
    });
    const result = await api<PageResult>(`/confluence-monitor/pages?${params}`);
    filterPageOptions.value = [
      ...new Map([...filterPageOptions.value, ...result.rows].map((page) => [page.id, page])).values(),
    ];
    filterPageNextStart.value = result.nextStart;
    filterPageHasMore.value = result.hasMore;
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không tải thêm được trang');
  } finally {
    filterPageLoading.value = false;
  }
}

async function saveRule() {
  if (!ruleForm.spaceKey) return ElMessage.warning('Hãy chọn Space');
  if (ruleForm.scopeType === 'SELECTED_PAGES' && ruleForm.pages.length === 0)
    return ElMessage.warning('Hãy chọn ít nhất một trang');
  const existingRule = rules.value.find((rule) => rule.id === ruleForm.id);
  const space = selectedSpace.value ?? {
    key: ruleForm.spaceKey,
    name: existingRule?.spaceName ?? ruleForm.spaceKey,
  };
  const body = {
    spaceKey: space.key,
    spaceName: space.name,
    scopeType: ruleForm.scopeType,
    pages:
      ruleForm.scopeType === 'SELECTED_PAGES'
        ? pageOptions.value.filter((page) => ruleForm.pages.includes(page.id))
        : [],
    ignoreMinorEdit: ruleForm.ignoreMinorEdit,
    enabled: ruleForm.enabled,
  };
  ruleSaving.value = true;
  try {
    await api(ruleForm.id ? `/confluence-monitor/rules/${ruleForm.id}` : '/confluence-monitor/rules', {
      method: ruleForm.id ? 'PUT' : 'POST',
      body: JSON.stringify(body),
    });
    rules.value = (await api<{ rows: Rule[] }>('/confluence-monitor/rules')).rows;
    ruleDialog.value = false;
    ElMessage.success(ruleForm.id ? 'Đã cập nhật cấu hình theo dõi' : 'Đã thêm Space theo dõi');
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không lưu được cấu hình');
  } finally {
    ruleSaving.value = false;
  }
}

async function toggleRule(rule: Rule) {
  try {
    await api(`/confluence-monitor/rules/${rule.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...rule, enabled: !rule.enabled }),
    });
    rule.enabled = !rule.enabled;
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không cập nhật được rule');
  }
}

async function removeRule(rule: Rule) {
  try {
    await ElMessageBox.confirm(`Ngừng theo dõi Space “${rule.spaceName}”?`, 'Xóa cấu hình theo dõi');
    await api(`/confluence-monitor/rules/${rule.id}`, { method: 'DELETE' });
    rules.value = rules.value.filter((item) => item.id !== rule.id);
    settings.syncSpaceKeys = settings.syncSpaceKeys.filter((key) => key !== rule.spaceKey);
    ElMessage.success('Đã xóa cấu hình theo dõi');
  } catch (cause) {
    if (cause !== 'cancel') ElMessage.error(cause instanceof Error ? cause.message : 'Không xóa được rule');
  }
}

async function saveBatchSettings() {
  savingSettings.value = true;
  try {
    const saved = await api<MonitorSettings>('/confluence-monitor/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
    Object.assign(settings, saved);
    ElMessage.success('Đã lưu lịch batch sync');
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không lưu được lịch sync');
  } finally {
    savingSettings.value = false;
  }
}

watch(
  () => ruleForm.spaceKey,
  () => {
    if (!ruleForm.id) {
      ruleForm.pages = [];
      pageOptions.value = [];
      pageNextStart.value = 0;
      pageHasMore.value = false;
    }
    if (ruleForm.spaceKey && ruleForm.scopeType === 'SELECTED_PAGES') void searchPages('');
  }
);
watch(
  () => ruleForm.scopeType,
  (scope) => {
    if (scope === 'SELECTED_PAGES' && ruleForm.spaceKey) void searchPages('');
  }
);
watch(
  () => filters.spaceKey,
  () => {
    filters.pageId = '';
    filterPageOptions.value = [];
    filterPageNextStart.value = 0;
    filterPageHasMore.value = false;
    void searchFilterPages();
  }
);
watch(
  () => route.query.change,
  (value) => {
    const id = Number(value);
    if (route.name === 'confluence-monitor' && Number.isInteger(id) && id > 0 && selectedChange.value?.id !== id)
      void openChange(id);
  }
);
onMounted(loadWorkspace);
</script>

<template>
  <div v-loading="loading" class="confluence-monitor">
    <Teleport to="#topbar-page-tabs">
      <div class="jira-topbar-tabs">
        <v-btn
          size="small"
          variant="text"
          :class="{ 'is-active': activeTab === 'changes' }"
          @click="activeTab = 'changes'"
        >
          <span class="jira-topbar-tab-icon">↻</span>Thay đổi
        </v-btn>
        <v-btn
          size="small"
          variant="text"
          :class="{ 'is-active': activeTab === 'monitoring' }"
          @click="activeTab = 'monitoring'"
        >
          <span class="jira-topbar-tab-icon">⚙</span>Theo dõi
        </v-btn>
      </div>
    </Teleport>

    <Teleport to="#topbar-page-actions">
      <div class="jira-topbar-btns">
        <span class="last-sync">Cập nhật: {{ formatTime(settings.lastSyncAt) }}</span>
        <v-btn size="small" color="primary" prepend-icon="mdi-sync" :loading="syncing" @click="manualSync"
          >Sync ngay</v-btn
        >
      </div>
    </Teleport>

    <section v-if="activeTab === 'changes'" class="changes-view">
      <header class="page-intro">
        <div>
          <p>CONFLUENCE DATA CENTER</p>
          <h1>Monitoring thay đổi</h1>
          <span>Theo dõi những cập nhật quan trọng từ các Space đã chọn.</span>
        </div>
        <button v-if="summary.unread" class="read-all" @click="markAllRead">
          <i class="mdi mdi-check-all" />Áp dụng tất cả version chờ
        </button>
      </header>

      <div class="metric-grid">
        <article>
          <i class="metric-icon blue mdi mdi-bell-ring-outline" />
          <div>
            <span>Thay đổi hôm nay</span><strong>{{ summary.todayChanges }}</strong
            ><small>Sự kiện được ghi nhận</small>
          </div>
        </article>
        <article>
          <i class="metric-icon green mdi mdi-check-decagram-outline" />
          <div>
            <span>Chờ xác nhận</span><strong>{{ summary.unread }}</strong
            ><small>Chờ áp dụng vào dữ liệu chính</small>
          </div>
        </article>
        <article>
          <i class="metric-icon orange mdi mdi-file-document-edit-outline" />
          <div>
            <span>Trang bị thay đổi</span><strong>{{ summary.changedPages }}</strong
            ><small>Trong các Space theo dõi</small>
          </div>
        </article>
        <article>
          <i class="metric-icon purple mdi mdi-account-group-outline" />
          <div>
            <span>Người thay đổi</span><strong>{{ summary.changers }}</strong
            ><small>Hôm nay</small>
          </div>
        </article>
      </div>

      <section class="monitor-card change-list-card">
        <div class="filters">
          <el-select v-model="filters.status" aria-label="Trạng thái" @change="applyFilters">
            <el-option label="Tất cả thay đổi chờ xác nhận" value="all" />
            <el-option label="Chưa đọc" value="unread" />
          </el-select>
          <el-select v-model="filters.spaceKey" clearable filterable placeholder="Tất cả Space" @change="applyFilters">
            <el-option v-for="space in filterSpaces" :key="space.key" :label="space.name" :value="space.key" />
          </el-select>
          <el-select
            v-model="filters.pageId"
            clearable
            filterable
            remote
            reserve-keyword
            :disabled="!filters.spaceKey"
            :loading="filterPageLoading"
            :remote-method="searchFilterPages"
            :placeholder="filters.spaceKey ? 'Tìm trang trong Space...' : 'Chọn Space trước'"
            @change="applyFilters"
            @visible-change="(visible: boolean) => visible && searchFilterPages()"
          >
            <el-option v-for="page in filterPageOptions" :key="page.id" :label="page.title" :value="page.id" />
            <template #footer>
              <v-btn
                v-if="filterPageHasMore"
                block
                size="small"
                variant="text"
                :loading="filterPageLoading"
                @click.stop="loadMoreFilterPages"
              >
                Tải thêm page
              </v-btn>
            </template>
          </el-select>
          <el-select v-model="filters.changedBy" clearable placeholder="Tất cả người" @change="applyFilters">
            <el-option v-for="person in filterChangers" :key="person.key" :label="person.name" :value="person.key" />
          </el-select>
          <el-date-picker
            v-model="filters.dates"
            type="daterange"
            value-format="YYYY-MM-DD"
            range-separator="→"
            start-placeholder="Từ ngày"
            end-placeholder="Đến ngày"
            placement="bottom-start"
            :fallback-placements="['bottom-start']"
            @change="applyFilters"
          />
          <button class="clear-filter" type="button" @click="clearFilters">
            <i class="mdi mdi-filter-remove-outline" />
            <span>Xóa lọc</span>
          </button>
        </div>

        <el-table
          :data="changes"
          row-class-name="change-row"
          empty-text="Chưa có thay đổi nào"
          @row-click="(row: ChangeEvent) => openChange(row.id)"
        >
          <el-table-column label="Trang" min-width="250">
            <template #default="{ row }"
              ><div class="page-cell">
                <i class="mdi mdi-file-document-outline" />
                <div>
                  <b>{{ row.pageTitle }}</b
                  ><small>ID: {{ row.pageId }}</small>
                </div>
              </div></template
            >
          </el-table-column>
          <el-table-column label="Space" min-width="145"
            ><template #default="{ row }"
              ><span class="space-label">{{ row.spaceName }}</span></template
            ></el-table-column
          >
          <el-table-column label="Version" width="105"
            ><template #default="{ row }"
              ><b class="version">{{ row.previousVersion }} → {{ row.currentVersion }}</b></template
            ></el-table-column
          >
          <el-table-column label="Người thay đổi" min-width="165"
            ><template #default="{ row }"
              ><div class="person">
                <span>{{ row.changedByName.slice(0, 1).toUpperCase() }}</span
                >{{ row.changedByName }}
              </div></template
            ></el-table-column
          >
          <el-table-column label="Thời gian" width="155"
            ><template #default="{ row }"
              ><span class="date-cell">{{ formatDate(row.changedAt) }}</span></template
            ></el-table-column
          >
          <el-table-column label="Minor Edit" width="100"
            ><template #default="{ row }"
              ><span :class="['minor-pill', { yes: row.minorEdit }]">{{
                row.minorEdit ? 'Có' : 'Không'
              }}</span></template
            ></el-table-column
          >
          <el-table-column label="Trạng thái" width="115"
            ><template #default="{ row }"
              ><span :class="['read-state', { read: row.isRead }]"
                ><i />{{ row.isRead ? 'Đã áp dụng' : 'Chờ xác nhận' }}</span
              ></template
            ></el-table-column
          >
        </el-table>
        <footer class="table-footer">
          <span>Hiển thị {{ changes.length }} trong {{ total }} thay đổi</span
          ><el-pagination
            v-model:current-page="pagination.page"
            :page-count="pageCount"
            layout="prev, pager, next"
            @current-change="loadChanges"
          />
        </footer>
      </section>
    </section>

    <section v-else class="monitoring-view">
      <header class="page-intro">
        <div>
          <p>CẤU HÌNH</p>
          <h1>Theo dõi Confluence</h1>
          <span>Chỉ quét những Space cần thiết để giảm lưu lượng đồng bộ.</span>
        </div>
        <v-btn color="primary" prepend-icon="mdi-plus" @click="resetRuleForm()">Thêm theo dõi</v-btn>
      </header>

      <div class="connection-grid">
        <article class="connection-card">
          <div class="connection-icon"><i class="mdi mdi-server-network" /></div>
          <div>
            <span>Confluence Connection</span><strong>{{ connection.name || 'Confluence Data Center' }}</strong
            ><small>{{ connection.baseUrl }}</small>
          </div>
          <span :class="['connection-state', { active: connection.configured && connection.lastConnectionAt }]">
            {{ connection.configured ? (connection.lastConnectionAt ? 'Connected' : 'Configured') : 'Chưa cấu hình' }}
          </span>
          <v-btn size="small" variant="tonal" :loading="testing" @click="testConnection">Kiểm tra</v-btn>
        </article>
        <article class="connection-card">
          <div class="connection-icon webhook"><i class="mdi mdi-webhook" /></div>
          <div>
            <span>Webhook</span><strong>Sự kiện page_updated</strong
            ><small>Lần nhận: {{ formatDate(connection.lastWebhookAt) }}</small>
          </div>
          <span :class="['connection-state', { active: connection.webhookStatus === 'active' }]">{{
            connection.webhookStatus === 'active' ? 'Active' : 'Inactive'
          }}</span>
          <v-btn size="small" variant="tonal" :loading="registeringWebhook" @click="registerWebhook">Kích hoạt</v-btn>
        </article>
      </div>

      <section class="monitor-card rules-card">
        <div class="card-heading">
          <div>
            <h2>Space đang theo dõi</h2>
            <p>Webhook dùng chung cho instance; rule bên dưới quyết định sự kiện nào được lưu.</p>
          </div>
          <span>{{ rules.filter((rule) => rule.enabled).length }} đang bật</span>
        </div>
        <div v-if="!rules.length" class="empty-state">
          <i class="mdi mdi-eye-off-outline" />
          <h3>Chưa có Space theo dõi</h3>
          <p>Thêm rule đầu tiên để bắt đầu nhận thay đổi.</p>
          <v-btn color="primary" @click="resetRuleForm()">Thêm theo dõi</v-btn>
        </div>
        <div v-else class="rule-table">
          <div class="rule-head">
            <span>Space</span><span>Phạm vi</span><span>Minor edit</span><span>Trạng thái</span><span />
          </div>
          <div v-for="rule in rules" :key="rule.id" class="rule-row">
            <div class="rule-space">
              <i class="mdi mdi-alpha-c-box-outline" />
              <div>
                <b>{{ rule.spaceName }}</b
                ><small>{{ rule.spaceKey }}</small>
              </div>
            </div>
            <div>
              <b>{{ rule.scopeType === 'ALL_PAGES' ? 'Tất cả trang' : `${rule.pages.length} trang` }}</b
              ><small v-if="rule.scopeType === 'SELECTED_PAGES'">{{
                rule.pages
                  .slice(0, 2)
                  .map((page) => page.title)
                  .join(', ')
              }}</small>
            </div>
            <div>
              <span :class="['rule-chip', { include: !rule.ignoreMinorEdit }]">{{
                rule.ignoreMinorEdit ? 'Bỏ qua' : 'Bao gồm'
              }}</span>
            </div>
            <div>
              <button :class="['status-toggle', { on: rule.enabled }]" @click="toggleRule(rule)">
                <i />{{ rule.enabled ? 'ON' : 'OFF' }}
              </button>
            </div>
            <div class="rule-actions">
              <button title="Chỉnh sửa" @click="resetRuleForm(rule)"><i class="mdi mdi-pencil-outline" /></button
              ><button title="Xóa" @click="removeRule(rule)"><i class="mdi mdi-trash-can-outline" /></button>
            </div>
          </div>
        </div>
      </section>

      <section class="monitor-card batch-card">
        <div class="card-heading">
          <div>
            <h2>Batch sync</h2>
            <p>Chạy hai lần mỗi ngày làm phương án dự phòng cho webhook.</p>
          </div>
          <el-switch v-model="settings.batchEnabled" inline-prompt active-text="Bật" inactive-text="Tắt" />
        </div>
        <div class="batch-form">
          <label
            ><span>Lần 1</span><el-time-select v-model="settings.firstSyncTime" start="00:00" step="00:30" end="23:30"
          /></label>
          <label
            ><span>Lần 2</span><el-time-select v-model="settings.secondSyncTime" start="00:00" step="00:30" end="23:30"
          /></label>
          <label class="space-sync"
            ><span>Space được sync</span
            ><el-select
              v-model="settings.syncSpaceKeys"
              class="config-space-select"
              multiple
              filterable
              collapse-tags
              collapse-tags-tooltip
              placeholder="Chọn Space"
              ><el-option
                v-for="space in monitoredSpaces"
                :key="space.key"
                :label="space.name"
                :value="space.key" /></el-select
          ></label>
          <div class="batch-action">
            <span>Lưu lịch</span>
            <v-btn class="batch-save" color="primary" :loading="savingSettings" @click="saveBatchSettings"
              >Lưu cấu hình</v-btn
            >
          </div>
        </div>
        <div class="batch-note">
          <i class="mdi mdi-information-outline" /><span
            >Múi giờ {{ settings.timezone }}. Nếu không chọn Space, hệ thống sync tất cả Space đang bật theo dõi. Lần
            sync gần nhất: {{ formatDate(settings.lastSyncAt) }}.</span
          >
        </div>
      </section>
    </section>

    <el-drawer
      v-model="drawer"
      size="460px"
      :before-close="
        (done: () => void) => {
          closeDrawer().then(done);
        }
      "
      class="change-drawer"
    >
      <template #header
        ><div class="drawer-title">
          <i class="mdi mdi-file-document-edit-outline" />
          <div>
            <small>CHI TIẾT THAY ĐỔI</small>
            <h3>{{ selectedChange?.pageTitle }}</h3>
          </div>
        </div></template
      >
      <div v-if="selectedChange" class="drawer-content">
        <div class="drawer-meta">
          <span
            >Space<b>{{ selectedChange.spaceName }}</b></span
          ><span
            >Page ID<b>{{ selectedChange.pageId }}</b></span
          >
        </div>
        <section class="version-panel">
          <small>VERSION</small>
          <div>
            <strong>{{ selectedChange.previousVersion }}</strong
            ><i class="mdi mdi-arrow-right" /><strong class="current">{{ selectedChange.currentVersion }}</strong>
          </div>
        </section>
        <dl>
          <div>
            <dt><i class="mdi mdi-account-outline" />Người thay đổi</dt>
            <dd>{{ selectedChange.changedByName }}</dd>
          </div>
          <div>
            <dt><i class="mdi mdi-clock-outline" />Thời gian</dt>
            <dd>{{ formatDate(selectedChange.changedAt) }}</dd>
          </div>
          <div>
            <dt><i class="mdi mdi-pencil-outline" />Minor edit</dt>
            <dd>{{ selectedChange.minorEdit ? 'Có' : 'Không' }}</dd>
          </div>
          <div v-if="selectedChange.versionMessage">
            <dt><i class="mdi mdi-message-text-outline" />Ghi chú version</dt>
            <dd>{{ selectedChange.versionMessage }}</dd>
          </div>
        </dl>
        <div class="drawer-actions">
          <v-btn color="primary" :href="selectedChange.confluenceUrl" target="_blank" append-icon="mdi-open-in-new"
            >Mở Confluence</v-btn
          ><v-btn variant="tonal" :href="historyUrl(selectedChange)" target="_blank">Xem History</v-btn
          ><v-btn v-if="!selectedChange.isRead" variant="outlined" prepend-icon="mdi-check" @click="markRead()"
            >Xác nhận và áp dụng</v-btn
          ><span v-else class="drawer-read"><i class="mdi mdi-check-circle" />Đã áp dụng</span>
        </div>
      </div>
    </el-drawer>

    <el-dialog
      v-model="ruleDialog"
      :title="ruleForm.id ? 'Chỉnh sửa theo dõi' : 'Thêm theo dõi'"
      width="560px"
      class="rule-dialog"
    >
      <div class="rule-form">
        <label
          ><span>Space <b>*</b></span
          ><el-select v-model="ruleForm.spaceKey" filterable placeholder="Chọn Space" :disabled="Boolean(ruleForm.id)"
            ><el-option
              v-for="space in spaces"
              :key="space.key"
              :label="`${space.name} (${space.key})`"
              :value="space.key" /></el-select
        ></label>
        <fieldset>
          <legend>Phạm vi <b>*</b></legend>
          <el-radio-group v-model="ruleForm.scopeType"
            ><el-radio value="ALL_PAGES">Tất cả page</el-radio
            ><el-radio value="SELECTED_PAGES">Chọn page</el-radio></el-radio-group
          >
        </fieldset>
        <label v-if="ruleForm.scopeType === 'SELECTED_PAGES'"
          ><span>Pages</span
          ><el-select
            v-model="ruleForm.pages"
            multiple
            filterable
            remote
            reserve-keyword
            :loading="pageLoading"
            :remote-method="searchPages"
            placeholder="Tìm và chọn page..."
            @visible-change="(visible: boolean) => visible && searchPages()"
            ><el-option v-for="page in pageOptions" :key="page.id" :label="page.title" :value="page.id" />
            <template #footer>
              <v-btn
                v-if="pageHasMore"
                block
                size="small"
                variant="text"
                :loading="pageLoading"
                @click.stop="loadMorePages"
              >
                Tải thêm page
              </v-btn>
            </template></el-select
          ></label
        >
        <div v-if="ruleForm.scopeType === 'SELECTED_PAGES'" class="page-search">
          <el-input
            v-model="pageSearch"
            clearable
            placeholder="Nhập tên page để tìm qua Confluence"
            @keyup.enter="searchPages()"
          /><v-btn
            class="page-search-button"
            size="small"
            color="primary"
            variant="flat"
            prepend-icon="mdi-magnify"
            :disabled="!ruleForm.spaceKey || pageLoading"
            :loading="pageLoading"
            @click="searchPages()"
            >Tìm page</v-btn
          >
        </div>
        <div class="form-switch">
          <div><b>Bỏ qua minor edit</b><span>Không tạo thông báo cho chỉnh sửa nhỏ.</span></div>
          <el-switch v-model="ruleForm.ignoreMinorEdit" />
        </div>
        <div class="form-switch">
          <div><b>Enable</b><span>Bắt đầu áp dụng rule ngay sau khi lưu.</span></div>
          <el-switch v-model="ruleForm.enabled" />
        </div>
      </div>
      <template #footer
        ><v-btn variant="text" @click="ruleDialog = false">Hủy</v-btn
        ><v-btn color="primary" :loading="ruleSaving" @click="saveRule">Lưu</v-btn></template
      >
    </el-dialog>
  </div>
</template>

<style scoped>
.confluence-monitor {
  --cf-blue: #2563eb;
  --cf-green: #16a34a;
  min-width: 0;
}
.page-intro {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 20px;
}
.page-intro p {
  margin: 0 0 5px;
  color: var(--cf-blue);
  font-size: 10px;
  font-weight: 850;
  letter-spacing: 0.14em;
}
.page-intro h1 {
  margin: 0;
  color: var(--text);
  font-size: 24px;
  letter-spacing: -0.035em;
}
.page-intro span {
  display: block;
  margin-top: 5px;
  color: var(--muted);
  font-size: 13px;
}
.read-all {
  border: 0;
  background: transparent;
  color: var(--cf-blue);
  cursor: pointer;
  font-weight: 700;
}
.read-all {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 12px;
  border-radius: 9px;
}
.read-all:hover {
  background: var(--control-hover);
}
.clear-filter {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 11px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: var(--panel);
  color: var(--muted);
  cursor: pointer;
  font-size: 11px;
  font-weight: 750;
  transition: border-color 0.16s ease, background 0.16s ease, color 0.16s ease;
}
.clear-filter i {
  color: var(--cf-blue);
  font-size: 15px;
}
.clear-filter:hover {
  border-color: rgb(37 99 235 / 35%);
  background: rgb(37 99 235 / 7%);
  color: var(--cf-blue);
}
.last-sync {
  color: var(--muted);
  font-size: 11px;
}
.metric-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  margin-bottom: 16px;
}
.metric-grid article {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 14px;
  padding: 17px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--card-gradient);
  box-shadow: 0 8px 24px var(--shadow-color);
}
.metric-grid article > div {
  display: grid;
  min-width: 0;
  gap: 2px;
}
.metric-grid span,
.metric-grid small {
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.metric-grid strong {
  color: var(--text);
  font-size: 24px;
  line-height: 1.1;
}
.metric-icon {
  display: grid;
  width: 43px;
  height: 43px;
  flex: 0 0 43px;
  place-items: center;
  border-radius: 12px;
  font-size: 21px;
}
.metric-icon.blue {
  background: rgb(37 99 235 / 13%);
  color: #3b82f6;
}
.metric-icon.green {
  background: rgb(22 163 74 / 13%);
  color: #22c55e;
}
.metric-icon.orange {
  background: rgb(234 88 12 / 13%);
  color: #f97316;
}
.metric-icon.purple {
  background: rgb(124 58 237 / 13%);
  color: #8b5cf6;
}
.monitor-card {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--panel);
  box-shadow: 0 10px 28px var(--shadow-color);
}
.filters {
  display: grid;
  grid-template-columns: 170px 1fr 1fr 1fr minmax(250px, 1.3fr) auto;
  gap: 9px;
  align-items: center;
  padding: 13px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-header-bg);
}
.filters :deep(.el-select),
.filters :deep(.el-date-editor) {
  width: 100%;
}
.change-list-card :deep(.el-table) {
  --el-table-bg-color: var(--panel);
  --el-table-tr-bg-color: var(--panel);
  --el-table-header-bg-color: var(--panel-header-bg);
  --el-table-row-hover-bg-color: var(--control-hover);
  --el-table-border-color: var(--line);
  color: var(--text);
}
.change-list-card :deep(.el-table th.el-table__cell) {
  color: var(--muted);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.change-list-card :deep(.change-row) {
  cursor: pointer;
}
.page-cell,
.person,
.rule-space {
  display: flex;
  align-items: center;
  gap: 10px;
}
.page-cell > i {
  display: grid;
  width: 31px;
  height: 31px;
  flex: 0 0 31px;
  place-items: center;
  border-radius: 8px;
  background: rgb(37 99 235 / 12%);
  color: #3b82f6;
  font-size: 17px;
}
.page-cell div,
.rule-space div {
  display: grid;
  min-width: 0;
  gap: 2px;
}
.page-cell b {
  overflow: hidden;
  color: var(--text);
  font-size: 12px;
  text-overflow: ellipsis;
}
.page-cell small,
.rule-space small {
  color: var(--muted);
  font-size: 10px;
}
.space-label,
.date-cell {
  color: var(--muted);
  font-size: 11px;
}
.version {
  color: #7aa7ff;
  font-size: 12px;
}
.person {
  color: var(--text);
  font-size: 11px;
}
.person > span {
  display: grid;
  width: 25px;
  height: 25px;
  place-items: center;
  border-radius: 50%;
  background: linear-gradient(145deg, #4f7dcc, #755bd6);
  color: #fff;
  font-size: 10px;
  font-weight: 800;
}
.minor-pill,
.rule-chip {
  display: inline-flex;
  padding: 4px 7px;
  border-radius: 6px;
  background: var(--soft);
  color: var(--muted);
  font-size: 10px;
  font-weight: 700;
}
.minor-pill.yes,
.rule-chip.include {
  background: rgb(245 158 11 / 12%);
  color: #e69010;
}
.read-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #397df0;
  font-size: 10px;
  font-weight: 750;
}
.read-state i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #397df0;
}
.read-state.read {
  color: var(--muted);
}
.read-state.read i {
  background: #94a3b8;
}
.table-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 14px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 11px;
}
.connection-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-bottom: 14px;
}
.connection-card {
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  align-items: center;
  gap: 13px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--card-gradient);
}
.connection-icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 12px;
  background: rgb(37 99 235 / 13%);
  color: #3b82f6;
  font-size: 21px;
}
.connection-icon.webhook {
  background: rgb(124 58 237 / 13%);
  color: #8b5cf6;
}
.connection-card > div:nth-child(2) {
  display: grid;
  min-width: 0;
  gap: 2px;
}
.connection-card span,
.connection-card small {
  overflow: hidden;
  color: var(--muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.connection-card strong {
  color: var(--text);
  font-size: 13px;
}
.connection-state {
  display: inline-flex !important;
  align-items: center;
  gap: 5px;
  color: #dc2626 !important;
  font-weight: 800;
}
.connection-state::before {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  content: '';
}
.connection-state.active {
  color: var(--cf-green) !important;
}
.rules-card {
  margin-bottom: 14px;
}
.card-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-header-bg);
}
.card-heading h2 {
  margin: 0;
  color: var(--text);
  font-size: 15px;
}
.card-heading p {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 11px;
}
.card-heading > span {
  padding: 5px 8px;
  border-radius: 7px;
  background: rgb(22 163 74 / 12%);
  color: var(--cf-green);
  font-size: 10px;
  font-weight: 800;
}
.rule-head,
.rule-row {
  display: grid;
  grid-template-columns: 1.25fr 1.25fr 0.7fr 0.65fr 80px;
  align-items: center;
  gap: 14px;
  padding: 11px 18px;
}
.rule-head {
  color: var(--muted);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}
.rule-row {
  min-height: 66px;
  border-top: 1px solid var(--line);
}
.rule-row > div:not(.rule-space, .rule-actions) {
  display: grid;
  gap: 3px;
}
.rule-row b {
  color: var(--text);
  font-size: 11px;
}
.rule-row small {
  overflow: hidden;
  color: var(--muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rule-space > i {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 9px;
  background: rgb(37 99 235 / 12%);
  color: #3b82f6;
  font-size: 19px;
}
.status-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 10px;
  font-weight: 850;
}
.status-toggle i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #94a3b8;
}
.status-toggle.on {
  color: var(--cf-green);
}
.status-toggle.on i {
  background: var(--cf-green);
  box-shadow: 0 0 0 4px rgb(22 163 74 / 10%);
}
.rule-actions {
  display: flex;
  justify-content: end;
  gap: 4px;
}
.rule-actions button {
  display: grid;
  width: 29px;
  height: 29px;
  place-items: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.rule-actions button:hover {
  background: var(--control-hover);
  color: var(--text);
}
.rule-actions button:last-child:hover {
  color: #ef4444;
}
.empty-state {
  display: grid;
  justify-items: center;
  padding: 42px;
  color: var(--muted);
  text-align: center;
}
.empty-state > i {
  font-size: 34px;
}
.empty-state h3 {
  margin: 8px 0 0;
  color: var(--text);
}
.empty-state p {
  margin: 5px 0 14px;
  font-size: 12px;
}
.batch-card {
  padding-bottom: 1px;
}
.batch-form {
  display: grid;
  grid-template-columns: minmax(132px, 0.6fr) minmax(132px, 0.6fr) minmax(280px, 1.8fr) auto;
  align-items: end;
  gap: 12px;
  padding: 18px;
}
.batch-form label,
.batch-action {
  display: grid;
  min-width: 0;
  gap: 6px;
}
.batch-form label > span,
.batch-action > span,
.rule-form label > span,
fieldset legend {
  color: var(--muted);
  font-size: 10px;
  font-weight: 750;
}
.batch-form :deep(.el-select),
.batch-form :deep(.el-date-editor) {
  width: 100%;
}
.batch-form :deep(.el-input__wrapper),
.batch-form :deep(.el-select__wrapper) {
  min-height: 36px;
}
.batch-action > span {
  visibility: hidden;
}
.batch-save {
  min-width: 128px;
  min-height: 36px !important;
}
.config-space-select :deep(.el-select__selection) {
  min-width: 0;
  overflow: hidden;
}
.config-space-select :deep(.el-tag) {
  max-width: calc(100% - 28px);
}
.config-space-select :deep(.el-tag__content) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.batch-note {
  display: flex;
  gap: 8px;
  margin: 0 18px 18px;
  padding: 10px 12px;
  border-radius: 9px;
  background: rgb(37 99 235 / 8%);
  color: var(--muted);
  font-size: 10px;
}
.batch-note i {
  color: #3b82f6;
}
.drawer-title {
  display: flex;
  align-items: center;
  gap: 11px;
}
.drawer-title > i {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border-radius: 10px;
  background: rgb(37 99 235 / 12%);
  color: #3b82f6;
  font-size: 20px;
}
.drawer-title small {
  color: var(--cf-blue);
  font-size: 9px;
  font-weight: 850;
  letter-spacing: 0.1em;
}
.drawer-title h3 {
  margin: 2px 0 0;
  color: var(--text);
  font-size: 16px;
}
.drawer-meta {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.drawer-meta span {
  display: grid;
  gap: 3px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  color: var(--muted);
  font-size: 9px;
  text-transform: uppercase;
}
.drawer-meta b {
  color: var(--text);
  font-size: 11px;
  text-transform: none;
}
.version-panel {
  margin: 16px 0;
  padding: 16px;
  border-radius: 11px;
  background: var(--soft);
}
.version-panel small {
  color: var(--muted);
  font-size: 9px;
  font-weight: 800;
}
.version-panel div {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 7px;
}
.version-panel strong {
  font-size: 23px;
}
.version-panel i {
  color: var(--muted);
}
.version-panel .current {
  color: var(--cf-blue);
}
.drawer-content dl {
  display: grid;
  gap: 0;
  margin: 0;
}
.drawer-content dl > div {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 13px 2px;
  border-bottom: 1px solid var(--line);
}
.drawer-content dt {
  color: var(--muted);
  font-size: 11px;
}
.drawer-content dt i {
  margin-right: 7px;
}
.drawer-content dd {
  margin: 0;
  color: var(--text);
  font-size: 11px;
  font-weight: 650;
  text-align: right;
}
.drawer-actions {
  display: grid;
  gap: 8px;
  margin-top: 22px;
}
.drawer-read {
  display: flex;
  justify-content: center;
  gap: 6px;
  color: var(--cf-green);
  font-size: 11px;
  font-weight: 750;
}
.rule-form {
  display: grid;
  gap: 18px;
}
.rule-form > label {
  display: grid;
  gap: 7px;
}
.rule-form :deep(.el-select) {
  width: 100%;
}
.rule-form b,
fieldset b {
  color: #ef4444;
}
.rule-form fieldset {
  margin: 0;
  padding: 0;
  border: 0;
}
.rule-form legend {
  margin-bottom: 8px;
}
.page-search {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 7px;
  margin-top: -10px;
}
.page-search :deep(.el-input__wrapper) {
  min-height: 34px;
}
.page-search-button {
  min-width: 102px;
  min-height: 34px !important;
  font-size: 11px;
  font-weight: 750;
  letter-spacing: 0;
  text-transform: none;
}
.form-switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
}
.form-switch > div {
  display: grid;
  gap: 2px;
}
.form-switch b {
  color: var(--text);
  font-size: 11px;
}
.form-switch span {
  color: var(--muted);
  font-size: 10px;
}
@media (max-width: 1200px) {
  .metric-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .filters {
    grid-template-columns: repeat(3, 1fr);
  }
  .batch-form {
    grid-template-columns: 1fr 1fr;
  }
  .space-sync {
    grid-column: 1 / -1;
  }
}
@media (max-width: 900px) {
  .connection-grid {
    grid-template-columns: 1fr;
  }
  .rule-head {
    display: none;
  }
  .rule-row {
    grid-template-columns: 1fr 1fr;
  }
  .rule-actions {
    grid-column: 2;
    grid-row: 1;
  }
  .filters {
    grid-template-columns: 1fr 1fr;
  }
  .filters :deep(.el-date-editor) {
    grid-column: 1 / -1;
  }
  .last-sync {
    display: none;
  }
}
@media (max-width: 600px) {
  .page-intro {
    align-items: start;
  }
  .metric-grid,
  .filters,
  .batch-form {
    grid-template-columns: 1fr;
  }
  .rule-row {
    grid-template-columns: 1fr;
  }
  .rule-actions {
    grid-column: 1;
    grid-row: auto;
    justify-content: start;
  }
  .connection-card {
    grid-template-columns: auto 1fr;
  }
  .connection-card .connection-state {
    justify-self: start;
  }
  .table-footer {
    align-items: start;
    flex-direction: column;
    gap: 8px;
  }
}
</style>
