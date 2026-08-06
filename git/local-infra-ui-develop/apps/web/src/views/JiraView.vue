<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, del, post } from '../api';

type Issue = {
  jiraId: string;
  jiraKey: string;
  projectKey: string;
  summary: string;
  description?: string;
  issueType?: string;
  status: string;
  statusCategory: string;
  assigneeName?: string;
  priority?: string;
  sprint?: string;
  dueDate?: string;
  parentKey?: string;
  parentSummary?: string;
  labels?: string; // JSON array string
  startDate?: string;
  jiraUpdatedAt: string;
  syncedAt: string;
  reportNote?: string;
  internalCategory?: string;
  blockReason?: string;
  highlight: number | boolean;
  risk: number | boolean;
};
type Resource = {
  id: string;
  name: string;
  url: string;
  type: string;
  jiraKey?: string;
  owner: string;
  visibility: string;
  description?: string;
  updatedAt: string;
};
type Settings = {
  jiraType: 'cloud' | 'data_center';
  baseUrl: string;
  jql: string;
  allowedProjects: string[];
  syncMode: 'manual' | 'interval';
  syncIntervalMinutes: number;
  staleDays: number;
  updatedAt?: string;
  hasToken?: boolean;
};
type ConnectionStatus = {
  connected: true;
  jiraType: 'cloud' | 'data_center';
  baseUrl: string;
  displayName: string;
  durationMs: number;
};
type Report = {
  groups: Array<{ name: string; total: number; done: number; inProgress: number; blocked: number }>;
  done: Issue[];
  inProgress: Issue[];
  blocked: Issue[];
  highlights: Issue[];
  risks: Issue[];
  markdown: string;
};
type WorklogReport = {
  members: string[];
  days: string[];
  matrix: Record<string, Record<string, number>>;
  totals: Record<string, number>;
  dateFrom: string;
  dateTo: string;
};
type WorklogByTicketReport = {
  tickets: string[];
  authors: string[];
  days: string[];
  matrix: Record<string, Record<string, Record<string, number>>>;
  ticketTotals: Record<string, number>;
  dateFrom: string;
  dateTo: string;
};
type Worklog = {
  id: string;
  jiraKey: string;
  authorName: string;
  timeSpentSeconds: number;
  started: string;
  comment?: string;
};
type Comment = {
  id: string;
  jiraKey: string;
  authorName: string;
  body?: string;
  createdAtJira: string;
};

const activeTab = ref('dashboard');
const loading = ref(false);
const syncing = ref(false);
const testingConnection = ref(false);
const connection = ref<ConnectionStatus | null>(null);
const issues = ref<Issue[]>([]);
const resources = ref<Resource[]>([]);
const dashboard = ref<any>({ metrics: {}, recentIssues: [], resources: [] });
const report = ref<Report>({
  groups: [],
  done: [],
  inProgress: [],
  blocked: [],
  highlights: [],
  risks: [],
  markdown: '',
});
const syncRuns = ref<any[]>([]);
const audits = ref<any[]>([]);
const filters = reactive({ q: '', status: '', assignee: '', priority: '', sprint: '' });
// Issue drawer detail data
const issueComments = ref<Comment[]>([]);
const issueWorklogs = ref<Worklog[]>([]);
const issueDetailTab = ref('info');
const loadingDetail = ref(false);
// Worklog report
const worklogReport = ref<WorklogReport | null>(null);
const worklogReportLoading = ref(false);
const worklogDateFrom = ref(new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
const worklogDateTo = ref(new Date().toISOString().slice(0, 10));
// Worklog by ticket report
const worklogByTicketReport = ref<WorklogByTicketReport | null>(null);
const worklogByTicketLoading = ref(false);
const worklogByTicketDateFrom = ref(new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
const worklogByTicketDateTo = ref(new Date().toISOString().slice(0, 10));
const worklogByTicketAuthor = ref('');
// Unified worklog state
const worklogMode = ref<'by-day' | 'by-member' | 'by-ticket'>('by-day');
const wlDateFrom = ref(new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
const wlDateTo = ref(new Date().toISOString().slice(0, 10));
const wlAuthorFilter = ref('');
const wlTicketFilter = ref('');
const wlLoading = ref(false);
// For by-member: same WorklogReport but filtered by member
const wlMemberReport = ref<WorklogReport | null>(null);
const wlByTicketReport = ref<WorklogByTicketReport | null>(null);
// allAuthors across last loaded report for filter dropdown
const wlKnownAuthors = ref<string[]>([]);
const wlKnownTickets = ref<string[]>([]);
const defaultSettings: Settings = {
  jiraType: 'cloud',
  baseUrl: '',
  jql: '',
  allowedProjects: [],
  syncMode: 'manual',
  syncIntervalMinutes: 30,
  staleDays: 5,
};
const settings = reactive<Settings>({ ...defaultSettings });
const allowedProjectsText = ref('');
const issueDrawer = ref(false);
const selectedIssue = ref<Issue | null>(null);
const metadata = reactive({ reportNote: '', internalCategory: '', blockReason: '', highlight: false, risk: false });
const resourceDialog = ref(false);
const editingResourceId = ref<string | null>(null);
const resourceForm = reactive({
  name: '',
  url: '',
  type: 'Document',
  jiraKey: '',
  owner: '',
  visibility: 'Team',
  description: '',
});

const unique = (key: keyof Issue) =>
  [...new Set(issues.value.map((item) => String(item[key] ?? '')).filter(Boolean))].sort();
const statusOptions = computed(() => unique('status'));
const assigneeOptions = computed(() => unique('assigneeName'));
const priorityOptions = computed(() => unique('priority'));
const sprintOptions = computed(() => unique('sprint'));
const parentOptions = computed(() =>
  [...new Set(issues.value.filter((i) => i.parentKey).map((i) => i.parentKey!))].sort()
);
function parseLabels(labels?: string): string[] {
  if (!labels) return [];
  try { return JSON.parse(labels); } catch { return []; }
}
const envTemplate = computed(() =>
  settings.jiraType === 'cloud'
    ? `JIRA_TYPE=cloud\nJIRA_BASE_URL=${settings.baseUrl || 'https://company.atlassian.net'}\nJIRA_INTERNAL_URL=\nJIRA_API_TOKEN=<atlassian-api-token>\nJIRA_EMAIL=<jira-account-email>\nJIRA_REQUEST_TIMEOUT_MS=15000`
    : `JIRA_TYPE=data_center\nJIRA_BASE_URL=${settings.baseUrl || 'https://jira.company.internal'}\nJIRA_INTERNAL_URL=\nJIRA_API_TOKEN=<jira-data-center-pat>\nJIRA_EMAIL=\nJIRA_REQUEST_TIMEOUT_MS=15000`
);
const configurationChecks = computed(() => [
  { label: 'Backend secret', ready: Boolean(settings.hasToken) },
  { label: 'Base URL', ready: Boolean(settings.baseUrl) },
  { label: 'Team JQL', ready: Boolean(settings.jql.trim()) },
  { label: 'Project allowlist', ready: Boolean(allowedProjectsText.value.trim()) },
  { label: 'Direct connection', ready: Boolean(connection.value?.connected) },
]);
const filteredIssues = computed(() => {
  const q = filters.q.trim().toLowerCase();
  return issues.value.filter(
    (issue) =>
      (!q || `${issue.jiraKey} ${issue.summary}`.toLowerCase().includes(q)) &&
      (!filters.status || issue.status === filters.status) &&
      (!filters.assignee || issue.assigneeName === filters.assignee) &&
      (!filters.priority || issue.priority === filters.priority) &&
      (!filters.sprint || issue.sprint === filters.sprint)
  );
});
const boardColumns = computed(() => {
  const order = ['new', 'indeterminate', 'done'];
  const labels: Record<string, string> = { new: 'To do', indeterminate: 'In progress / Review', done: 'Done' };
  return order.map((category) => ({
    category,
    label: labels[category],
    issues: filteredIssues.value.filter((issue) => issue.statusCategory === category),
  }));
});

function statusType(issue: Issue) {
  if (issue.statusCategory === 'done') return 'success';
  if (issue.status.toLowerCase().includes('block')) return 'danger';
  if (issue.statusCategory === 'indeterminate') return 'warning';
  return 'info';
}
function date(value?: string | Date | null) {
  if (!value) return '—';
  // If already a Date object (e.g. from mysql2)
  if (value instanceof Date) {
    const dd = String(value.getDate()).padStart(2, '0');
    const mm = String(value.getMonth() + 1).padStart(2, '0');
    const yyyy = value.getFullYear();
    const hh = String(value.getHours()).padStart(2, '0');
    const min = String(value.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
  }
  const str = String(value);
  // Plain date YYYY-MM-DD → parse manually to avoid UTC-offset day shift
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [yyyy, mm, dd] = str.split('-');
    return `${dd}/${mm}/${yyyy}`;
  }
  const d = new Date(str);
  if (isNaN(d.getTime())) return str;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}
function formatDay(isoDay: unknown): string {
  if (!isoDay) return '—';
  // If Date object from mysql2 (shouldn't happen after DB fix but safeguard)
  if (isoDay instanceof Date) {
    const dd = String(isoDay.getUTCDate()).padStart(2, '0');
    const mm = String(isoDay.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = isoDay.getUTCFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
  const str = String(isoDay);
  // Expect YYYY-MM-DD
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return str;
}
function jiraUrl(issue: Issue) {
  return `${settings.baseUrl}/browse/${encodeURIComponent(issue.jiraKey)}`;
}

async function loadAll() {
  loading.value = true;
  try {
    const [dashboardData, issueData, resourceData, settingsData, reportData, runData, auditData] = await Promise.all([
      api<any>('/jira/dashboard'),
      api<{ rows: Issue[] }>('/jira/issues'),
      api<{ rows: Resource[] }>('/jira/resources'),
      api<Settings>('/jira/settings'),
      api<Report>('/jira/reports/weekly'),
      api<{ rows: any[] }>('/jira/sync-runs'),
      api<{ rows: any[] }>('/jira/audit'),
    ]);
    dashboard.value = dashboardData;
    issues.value = issueData.rows;
    resources.value = resourceData.rows;
    Object.assign(settings, settingsData);
    allowedProjectsText.value = settingsData.allowedProjects.join(', ');
    report.value = reportData;
    syncRuns.value = runData.rows;
    audits.value = auditData.rows;
  } catch (cause: unknown) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không tải được Jira workspace');
  } finally {
    loading.value = false;
  }
}

async function openIssue(issue: Issue) {
  selectedIssue.value = issue;
  Object.assign(metadata, {
    reportNote: issue.reportNote ?? '',
    internalCategory: issue.internalCategory ?? '',
    blockReason: issue.blockReason ?? '',
    highlight: Boolean(issue.highlight),
    risk: Boolean(issue.risk),
  });
  issueDetailTab.value = 'info';
  issueComments.value = [];
  issueWorklogs.value = [];
  issueDrawer.value = true;
  // Load comments and worklogs in background
  loadingDetail.value = true;
  try {
    const [commentsRes, worklogsRes] = await Promise.all([
      api<{ rows: Comment[] }>(`/jira/issues/${issue.jiraKey}/comments`),
      api<{ rows: Worklog[] }>(`/jira/issues/${issue.jiraKey}/worklogs`),
    ]);
    issueComments.value = commentsRes.rows;
    issueWorklogs.value = worklogsRes.rows;
  } catch {
    // non-fatal
  } finally {
    loadingDetail.value = false;
  }
}
async function saveMetadata() {
  if (!selectedIssue.value) return;
  try {
    await api(`/jira/issues/${selectedIssue.value.jiraKey}/metadata`, {
      method: 'PATCH',
      body: JSON.stringify(metadata),
    });
    ElMessage.success('Đã lưu metadata nội bộ');
    issueDrawer.value = false;
    await loadAll();
  } catch (cause: unknown) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không lưu được metadata');
  }
}
async function syncJira() {
  syncing.value = true;
  try {
    const result = await post<any>('/jira/sync');
    ElMessage.success(
      `Sync xong: ${result.created} mới, ${result.updated} cập nhật, ${result.deleted ?? 0} đã loại khỏi cache`
    );
    await loadAll();
  } catch (cause: unknown) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Sync Jira thất bại');
  } finally {
    syncing.value = false;
  }
}
async function testConnection() {
  testingConnection.value = true;
  connection.value = null;
  try {
    connection.value = await api<ConnectionStatus>('/jira/connection');
    ElMessage.success(`Đã kết nối trực tiếp với Jira bằng ${connection.value.displayName}`);
  } catch (cause: unknown) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không kết nối được Jira');
  } finally {
    testingConnection.value = false;
  }
}
async function saveSettings() {
  const projects = allowedProjectsText.value
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  try {
    const saved = await api<Settings>('/jira/settings', {
      method: 'PATCH',
      body: JSON.stringify({ ...settings, allowedProjects: projects }),
    });
    Object.assign(settings, saved);
    connection.value = null;
    allowedProjectsText.value = saved.allowedProjects.join(', ');
    ElMessage.success('Đã lưu cấu hình Jira');
  } catch (cause: unknown) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không lưu được cấu hình');
  }
}

function openResource(resource?: Resource) {
  editingResourceId.value = resource?.id ?? null;
  Object.assign(
    resourceForm,
    resource
      ? {
          name: resource.name,
          url: resource.url,
          type: resource.type,
          jiraKey: resource.jiraKey ?? '',
          owner: resource.owner,
          visibility: resource.visibility,
          description: resource.description ?? '',
        }
      : { name: '', url: '', type: 'Document', jiraKey: '', owner: '', visibility: 'Team', description: '' }
  );
  resourceDialog.value = true;
}
async function saveResource() {
  try {
    if (editingResourceId.value)
      await api(`/jira/resources/${editingResourceId.value}`, { method: 'PATCH', body: JSON.stringify(resourceForm) });
    else await post('/jira/resources', resourceForm);
    resourceDialog.value = false;
    ElMessage.success('Đã lưu resource');
    await loadAll();
  } catch (cause: unknown) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không lưu được resource');
  }
}
async function removeResource(resource: Resource) {
  try {
    await ElMessageBox.confirm(`Xóa link “${resource.name}”?`, 'Xác nhận', { type: 'warning' });
    await del(`/jira/resources/${resource.id}`);
    ElMessage.success('Đã xóa resource');
    await loadAll();
  } catch (cause: any) {
    if (cause !== 'cancel' && cause !== 'close')
      ElMessage.error(cause instanceof Error ? cause.message : 'Không xóa được resource');
  }
}
async function copyReport() {
  await navigator.clipboard.writeText(report.value.markdown);
  ElMessage.success('Đã copy Markdown');
}
async function copyEnvTemplate() {
  await navigator.clipboard.writeText(envTemplate.value);
  ElMessage.success('Đã copy mẫu biến môi trường');
}
function exportCsv() {
  const safe = (value: unknown) => {
    const text = String(value ?? '');
    const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${guarded.replaceAll('"', '""')}"`;
  };
  const rows = [
    ['Jira Key', 'Summary', 'Status', 'Assignee', 'Priority', 'Sprint', 'Parent', 'Start date', 'Due date', 'Labels', 'Category', 'Report note'],
    ...issues.value.map((issue) => [
      issue.jiraKey,
      issue.summary,
      issue.status,
      issue.assigneeName,
      issue.priority,
      issue.sprint,
      issue.parentKey,
      issue.startDate,
      issue.dueDate,
      parseLabels(issue.labels).join('; '),
      issue.internalCategory,
      issue.reportNote,
    ]),
  ];
  const blob = new Blob([`\uFEFF${rows.map((row) => row.map(safe).join(',')).join('\n')}`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'jira-weekly-report.csv';
  anchor.click();
  URL.revokeObjectURL(url);
}

async function loadWorklogReport() {
  worklogReportLoading.value = true;
  try {
    worklogReport.value = await api<WorklogReport>(
      `/jira/worklogs/report?dateFrom=${worklogDateFrom.value}&dateTo=${worklogDateTo.value}`
    );
  } catch (cause: unknown) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không tải được worklog report');
  } finally {
    worklogReportLoading.value = false;
  }
}

async function loadWorklogByTicketReport() {
  worklogByTicketLoading.value = true;
  try {
    const authorParam = worklogByTicketAuthor.value ? `&authorName=${encodeURIComponent(worklogByTicketAuthor.value)}` : '';
    worklogByTicketReport.value = await api<WorklogByTicketReport>(
      `/jira/worklogs/report/by-ticket?dateFrom=${worklogByTicketDateFrom.value}&dateTo=${worklogByTicketDateTo.value}${authorParam}`
    );
  } catch (cause: unknown) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không tải được worklog theo ticket');
  } finally {
    worklogByTicketLoading.value = false;
  }
}

async function loadActiveWorklog() {
  wlLoading.value = true;
  try {
    if (worklogMode.value === 'by-day' || worklogMode.value === 'by-member') {
      const authorParam = (worklogMode.value === 'by-member' && wlAuthorFilter.value)
        ? `&assignee=${encodeURIComponent(wlAuthorFilter.value)}` : '';
      const data = await api<WorklogReport>(
        `/jira/worklogs/report?dateFrom=${wlDateFrom.value}&dateTo=${wlDateTo.value}${authorParam}`
      );
      wlMemberReport.value = data;
      // populate author list from members
      if (data.members.length) wlKnownAuthors.value = [...data.members].sort();
    } else {
      const authorParam = wlAuthorFilter.value ? `&authorName=${encodeURIComponent(wlAuthorFilter.value)}` : '';
      const ticketParam = wlTicketFilter.value ? `&jiraKey=${encodeURIComponent(wlTicketFilter.value)}` : '';
      const data = await api<WorklogByTicketReport>(
        `/jira/worklogs/report/by-ticket?dateFrom=${wlDateFrom.value}&dateTo=${wlDateTo.value}${authorParam}${ticketParam}`
      );
      wlByTicketReport.value = data;
      if (data.authors.length) wlKnownAuthors.value = [...data.authors].sort();
      if (data.tickets.length) wlKnownTickets.value = [...data.tickets].sort();
    }
  } catch (cause: unknown) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Không tải được worklog');
  } finally {
    wlLoading.value = false;
  }
}

function secondsToHours(seconds: number) {
  return (seconds / 3600).toFixed(1);
}

function heatmapColor(seconds: number) {
  if (!seconds) return 'transparent';
  const hours = seconds / 3600;
  if (hours >= 8) return '#1a6b3c';
  if (hours >= 4) return '#276749';
  if (hours >= 2) return '#2f7a56';
  if (hours >= 1) return '#37895e';
  return '#1d4e38';
}

function exportWorklogCsv() {
  const data = wlMemberReport.value;
  if (!data) return;
  const { members, days, matrix, totals } = data;
  const safe = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const header = ['Thành viên', ...days.map(formatDay), 'Tổng (giờ)'];
  const dataRows = members.map((m) => [
    m,
    ...days.map((d) => secondsToHours(matrix[m]?.[d] ?? 0)),
    secondsToHours(totals[m] ?? 0),
  ]);
  const blob = new Blob([`\uFEFF${[header, ...dataRows].map((r) => r.map(safe).join(',')).join('\n')}`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'jira-worklog-report.csv';
  anchor.click();
  URL.revokeObjectURL(url);
}

function exportWorklogByTicketCsv() {
  const data = wlByTicketReport.value;
  if (!data) return;
  const { tickets, authors, days, matrix, ticketTotals } = data;
  const safe = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const header = ['Ticket', ...days.map(formatDay), 'Tổng (giờ)'];
  const dataRows: (string | number)[][] = [];
  for (const ticket of tickets) {
    const dayTotals = days.map((d) =>
      Object.values(matrix[ticket] ?? {}).reduce((sum, m) => sum + (m[d] ?? 0), 0)
    );
    const total = ticketTotals[ticket] ?? 0;
    dataRows.push([ticket, ...dayTotals.map(secondsToHours), secondsToHours(total)]);
  }
  const blob = new Blob([`\uFEFF${[header, ...dataRows].map((r) => r.map(safe).join(',')).join('\n')}`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'jira-worklog-by-ticket.csv';
  anchor.click();
  URL.revokeObjectURL(url);
}

onMounted(loadAll);
</script>

<template>
  <div v-loading="loading" class="jira-workspace">
    <!-- Teleport Jira action buttons into the global topbar next to "coder-workspace · connected" -->
    <Teleport to="#topbar-page-actions">
      <div class="jira-topbar-btns">
        <el-tag :type="settings.hasToken ? 'success' : 'warning'" effect="dark" size="small">{{ settings.hasToken ? '✓ Token OK' : '⚠ Token missing' }}</el-tag>
        <a v-if="settings.baseUrl" :href="settings.baseUrl" target="_blank" rel="noreferrer">
          <el-button size="small">Open Jira ↗</el-button>
        </a>
        <el-button size="small" :loading="syncing" type="primary" @click="syncJira">⟳ Sync Jira</el-button>
      </div>
    </Teleport>

    <el-tabs v-model="activeTab" class="jira-tabs">

      <el-tab-pane name="dashboard">
        <template #label>
          <span class="jira-tab-label"
            ><i>⌂</i><span><b>Tổng quan</b><small>Tiến độ và cảnh báo</small></span></span
          >
        </template>
        <div class="jira-metrics">
          <article>
            <span>Open tasks</span><strong>{{ dashboard.metrics.open ?? 0 }}</strong
            ><small>{{ dashboard.metrics.stale ?? 0 }} task không cập nhật quá {{ settings.staleDays }} ngày</small>
          </article>
          <article>
            <span>In progress</span><strong>{{ dashboard.metrics.inProgress ?? 0 }}</strong
            ><small>Đang xử lý trong team</small>
          </article>
          <article class="danger">
            <span>Blocked</span><strong>{{ dashboard.metrics.blocked ?? 0 }}</strong
            ><small>{{ dashboard.metrics.overdue ?? 0 }} task quá hạn</small>
          </article>
          <article class="success">
            <span>Done this week</span><strong>{{ dashboard.metrics.doneThisWeek ?? 0 }}</strong
            ><small>Hoàn thành trong 7 ngày</small>
          </article>
        </div>
        <div class="jira-grid dashboard-grid">
          <section class="jira-card">
            <div class="jira-card-head">
              <div>
                <h3>Recently updated</h3>
                <small>Cache Jira mới nhất</small>
              </div>
              <el-button text @click="activeTab = 'issues'">View all</el-button>
            </div>
            <button
              v-for="issue in dashboard.recentIssues"
              :key="issue.jiraKey"
              class="activity-row"
              @click="openIssue(issue)"
            >
              <span
                ><b>{{ issue.jiraKey }}</b
                >{{ issue.summary }}</span
              ><el-tag size="small" :type="statusType(issue)">{{ issue.status }}</el-tag>
            </button>
          </section>
          <section class="jira-card">
            <div class="jira-card-head">
              <div>
                <h3>Useful links</h3>
                <small>Resource của team</small>
              </div>
              <el-button text @click="openResource()">+ Add</el-button>
            </div>
            <a
              v-for="item in resources.slice(0, 5)"
              :key="item.id"
              class="resource-link"
              :href="item.url"
              target="_blank"
              rel="noreferrer"
              ><span
                ><b>{{ item.name }}</b
                ><small>{{ item.owner }}</small></span
              ><el-tag size="small" effect="plain">{{ item.type }}</el-tag></a
            >
            <el-empty v-if="!resources.length" description="Chưa có resource" :image-size="54" />
          </section>
        </div>
      </el-tab-pane>

      <el-tab-pane name="issues">
        <template #label>
          <span class="jira-tab-label"
            ><i>✓</i
            ><span
              ><b>Issues</b><small>{{ issues.length }} công việc</small></span
            ></span
          >
        </template>
        <section class="jira-card">
          <div class="issue-filters">
            <el-input v-model="filters.q" clearable placeholder="Tìm key hoặc summary..." />
            <el-select v-model="filters.status" clearable placeholder="Status"
              ><el-option v-for="item in statusOptions" :key="item" :value="item"
            /></el-select>
            <el-select v-model="filters.assignee" clearable placeholder="Assignee"
              ><el-option v-for="item in assigneeOptions" :key="item" :value="item"
            /></el-select>
            <el-select v-model="filters.priority" clearable placeholder="Priority"
              ><el-option v-for="item in priorityOptions" :key="item" :value="item"
            /></el-select>
            <el-select v-model="filters.sprint" clearable placeholder="Sprint"
              ><el-option v-for="item in sprintOptions" :key="item" :value="item"
            /></el-select>
          </div>
          <el-table :data="filteredIssues" row-key="jiraKey" @row-click="openIssue">
            <el-table-column label="Issue" min-width="300"
              ><template #default="{ row }"
                ><div class="issue-title">
                  <b>{{ row.jiraKey }}</b
                  ><span>{{ row.summary }}</span>
                </div></template
              ></el-table-column
            >
            <el-table-column label="Status" width="140"
              ><template #default="{ row }"
                ><el-tag :type="statusType(row)">{{ row.status }}</el-tag></template
              ></el-table-column
            >
            <el-table-column label="Parent" width="120"
              ><template #default="{ row }"
                ><span v-if="row.parentKey" class="parent-chip" :title="row.parentSummary">{{ row.parentKey }}</span
                ><span v-else class="text-muted">—</span></template
              ></el-table-column
            >
            <el-table-column label="Sprint" width="130"
              ><template #default="{ row }">{{ row.sprint || '—' }}</template></el-table-column
            >
            <el-table-column prop="assigneeName" label="Assignee" width="130" />
            <el-table-column label="Start" width="110"
              ><template #default="{ row }">{{ date(row.startDate) }}</template></el-table-column
            >
            <el-table-column label="Due" width="110"
              ><template #default="{ row }">{{ date(row.dueDate) }}</template></el-table-column
            >
            <el-table-column label="Labels" min-width="140"
              ><template #default="{ row }"
                ><span v-for="lbl in parseLabels(row.labels)" :key="lbl" class="label-chip">{{ lbl }}</span></template
              ></el-table-column
            >
          </el-table>
        </section>
      </el-tab-pane>

      <el-tab-pane name="board">
        <template #label>
          <span class="jira-tab-label"
            ><i>▦</i><span><b>Board</b><small>Theo luồng trạng thái</small></span></span
          >
        </template>
        <div class="board-filters">
          <el-input v-model="filters.q" clearable placeholder="Filter board..." /><el-select
            v-model="filters.assignee"
            clearable
            placeholder="All members"
            ><el-option v-for="item in assigneeOptions" :key="item" :value="item" /></el-select
          ><el-select v-model="filters.sprint" clearable placeholder="All sprints"
            ><el-option v-for="item in sprintOptions" :key="item" :value="item"
          /></el-select>
        </div>
        <div class="jira-board">
          <section v-for="column in boardColumns" :key="column.category" class="board-column">
            <header>
              <b>{{ column.label }}</b
              ><span>{{ column.issues.length }}</span>
            </header>
            <button v-for="issue in column.issues" :key="issue.jiraKey" class="board-card" @click="openIssue(issue)">
              <b>{{ issue.jiraKey }}</b
              ><strong>{{ issue.summary }}</strong>
              <div>
                <el-tag size="small" :type="statusType(issue)">{{ issue.status }}</el-tag
                ><span>{{ issue.assigneeName || 'Unassigned' }}</span>
              </div>
            </button>
          </section>
        </div>
      </el-tab-pane>

      <el-tab-pane name="reports">
        <template #label>
          <span class="jira-tab-label"
            ><i>↗</i><span><b>Báo cáo</b><small>Weekly và logwork</small></span></span
          >
        </template>
        <div class="report-actions">
          <p>Tổng hợp tự động từ cache Jira và metadata lưu trong MySQL.</p>
          <div>
            <el-button @click="copyReport">Copy Markdown</el-button
            ><el-button type="primary" @click="exportCsv">Export CSV issues</el-button>
          </div>
        </div>
        <div class="jira-grid report-grid">
          <section class="jira-card">
            <h3>Team delivery</h3>
            <div v-for="group in report.groups" :key="group.name" class="report-group">
              <div>
                <span>{{ group.name }}</span
                ><b>{{ group.done }}/{{ group.total }} done</b>
              </div>
              <el-progress
                :percentage="group.total ? Math.round((group.done / group.total) * 100) : 0"
                :stroke-width="10"
              />
            </div>
          </section>
          <section class="jira-card report-summary">
            <h3>Weekly summary</h3>
            <div>
              <span>Done</span><b>{{ report.done.length }}</b>
            </div>
            <div>
              <span>In progress</span><b>{{ report.inProgress.length }}</b>
            </div>
            <div>
              <span>Blocked</span><b>{{ report.blocked.length }}</b>
            </div>
            <h4>Highlights</h4>
            <p v-for="item in report.highlights" :key="item.jiraKey">
              <b>{{ item.jiraKey }}</b> {{ item.reportNote || item.summary }}
            </p>
            <h4>Risks / blockers</h4>
            <p v-for="item in report.risks" :key="item.jiraKey">
              <b>{{ item.jiraKey }}</b> {{ item.blockReason || item.reportNote || item.summary }}
            </p>
          </section>
        </div>

        <!-- Logwork section thống nhất -->
        <section class="jira-card worklog-report-card">
          <!-- Header + Mode selector -->
          <div class="worklog-report-header">
            <div>
              <h3>Logwork</h3>
              <small>Tổng giờ làm việc theo dữ liệu Jira worklog</small>
            </div>
            <el-radio-group v-model="worklogMode" size="small" class="wl-mode-group">
              <el-radio-button value="by-day">Theo ngày</el-radio-button>
              <el-radio-button value="by-member">Theo thành viên</el-radio-button>
              <el-radio-button value="by-ticket">Theo ticket</el-radio-button>
            </el-radio-group>
          </div>

          <!-- Controls: date range + filters -->
          <div class="worklog-report-controls wl-controls-bar">
            <el-date-picker v-model="wlDateFrom" type="date" placeholder="Từ ngày" format="DD/MM/YYYY" value-format="YYYY-MM-DD" size="small" />
            <el-date-picker v-model="wlDateTo" type="date" placeholder="Đến ngày" format="DD/MM/YYYY" value-format="YYYY-MM-DD" size="small" />
            <!-- Filter thành viên (dùng cho tất cả 3 modes) -->
            <el-select
              v-model="wlAuthorFilter"
              clearable
              placeholder="Tất cả thành viên"
              size="small"
              style="width: 175px"
            >
              <el-option v-for="a in wlKnownAuthors" :key="a" :label="a" :value="a" />
            </el-select>
            <!-- Filter ticket (chỉ hiện khi mode by-ticket) -->
            <el-select
              v-if="worklogMode === 'by-ticket'"
              v-model="wlTicketFilter"
              clearable
              filterable
              placeholder="Tất cả ticket"
              size="small"
              style="width: 160px"
            >
              <el-option v-for="t in wlKnownTickets" :key="t" :label="t" :value="t" />
            </el-select>
            <el-button size="small" type="primary" :loading="wlLoading" @click="loadActiveWorklog">Xem báo cáo</el-button>
            <el-button
              v-if="worklogMode !== 'by-ticket'"
              size="small"
              :disabled="!wlMemberReport"
              @click="exportWorklogCsv"
            >Export CSV</el-button>
            <el-button
              v-else
              size="small"
              :disabled="!wlByTicketReport"
              @click="exportWorklogByTicketCsv"
            >Export CSV</el-button>
          </div>

          <!-- Legend -->
          <div v-if="(worklogMode !== 'by-ticket' && wlMemberReport) || (worklogMode === 'by-ticket' && wlByTicketReport)" class="worklog-legend">
            <span>Giờ log:</span>
            <span class="legend-dot" style="background:#1d4e38">0-1h</span>
            <span class="legend-dot" style="background:#37895e">1-2h</span>
            <span class="legend-dot" style="background:#2f7a56">2-4h</span>
            <span class="legend-dot" style="background:#276749">4-8h</span>
            <span class="legend-dot" style="background:#1a6b3c">≥8h</span>
          </div>

          <!-- VIEW: Theo ngày (heatmap thành viên × ngày) -->
          <template v-if="worklogMode === 'by-day'">
            <div v-if="wlMemberReport && wlMemberReport.members.length" class="worklog-matrix-wrap">
              <div class="worklog-matrix">
                <table class="wl-table">
                  <thead>
                    <tr>
                      <th class="member-col">Thành viên</th>
                      <th v-for="day in wlMemberReport.days" :key="day" class="day-col">{{ formatDay(day) }}</th>
                      <th class="total-col">Tổng</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="member in wlMemberReport.members" :key="member">
                      <td class="member-name">{{ member }}</td>
                      <td
                        v-for="day in wlMemberReport.days"
                        :key="day"
                        class="wl-cell"
                        :style="{ background: heatmapColor(wlMemberReport.matrix[member]?.[day] ?? 0) }"
                        :title="`${member} · ${formatDay(day)}: ${secondsToHours(wlMemberReport.matrix[member]?.[day] ?? 0)}h`"
                      >
                        <span v-if="wlMemberReport.matrix[member]?.[day]">
                          {{ secondsToHours(wlMemberReport.matrix[member][day]) }}
                        </span>
                      </td>
                      <td class="total-cell">{{ secondsToHours(wlMemberReport.totals[member] ?? 0) }}h</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <el-empty v-else-if="wlMemberReport && !wlMemberReport.members.length" description="Không có dữ liệu logwork" :image-size="60" />
            <div v-else class="worklog-placeholder"><span>Chọn khoảng ngày và nhấn <b>Xem báo cáo</b>.</span></div>
          </template>

          <!-- VIEW: Theo thành viên (mỗi người = 1 row tổng theo ngày) -->
          <template v-else-if="worklogMode === 'by-member'">
            <div v-if="wlMemberReport && wlMemberReport.members.length" class="worklog-matrix-wrap">
              <div class="worklog-matrix">
                <table class="wl-table">
                  <thead>
                    <tr>
                      <th class="member-col">Thành viên</th>
                      <th v-for="day in wlMemberReport.days" :key="day" class="day-col">{{ formatDay(day) }}</th>
                      <th class="total-col">Tổng</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="member in (wlAuthorFilter ? [wlAuthorFilter] : wlMemberReport.members)"
                      :key="member"
                    >
                      <td class="member-name">{{ member }}</td>
                      <td
                        v-for="day in wlMemberReport.days"
                        :key="day"
                        class="wl-cell"
                        :style="{ background: heatmapColor(wlMemberReport.matrix[member]?.[day] ?? 0) }"
                        :title="`${member} · ${formatDay(day)}: ${secondsToHours(wlMemberReport.matrix[member]?.[day] ?? 0)}h`"
                      >
                        <span v-if="wlMemberReport.matrix[member]?.[day]">
                          {{ secondsToHours(wlMemberReport.matrix[member][day]) }}
                        </span>
                      </td>
                      <td class="total-cell">{{ secondsToHours(wlMemberReport.totals[member] ?? 0) }}h</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <el-empty v-else-if="wlMemberReport && !wlMemberReport.members.length" description="Không có dữ liệu logwork" :image-size="60" />
            <div v-else class="worklog-placeholder"><span>Chọn khoảng ngày và nhấn <b>Xem báo cáo</b>.</span></div>
          </template>

          <!-- VIEW: Theo ticket (1 row = 1 ticket, cột ngày, không cột thành viên) -->
          <template v-else>
            <div v-if="wlByTicketReport && wlByTicketReport.tickets.length" class="worklog-matrix-wrap">
              <div class="worklog-matrix">
                <table class="wl-table wl-ticket-table">
                  <thead>
                    <tr>
                      <th class="member-col">Ticket</th>
                      <th v-for="day in wlByTicketReport.days" :key="day" class="day-col">{{ formatDay(day) }}</th>
                      <th class="total-col">Tổng</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="ticket in (wlTicketFilter ? [wlTicketFilter] : wlByTicketReport.tickets)"
                      :key="ticket"
                    >
                      <td class="ticket-key-cell">
                        <b>{{ ticket }}</b>
                      </td>
                      <td
                        v-for="day in wlByTicketReport.days"
                        :key="day"
                        class="wl-cell"
                        :style="{ background: heatmapColor(
                          Object.values(wlByTicketReport.matrix[ticket] ?? {}).reduce(
                            (sum, authMap) => sum + (authMap[day] ?? 0), 0
                          )
                        )}"
                        :title="`${ticket} · ${formatDay(day)}: ${secondsToHours(
                          Object.values(wlByTicketReport.matrix[ticket] ?? {}).reduce(
                            (sum, authMap) => sum + (authMap[day] ?? 0), 0
                          )
                        )}h`"
                      >
                        <span v-if="Object.values(wlByTicketReport.matrix[ticket] ?? {}).some(m => m[day])">
                          {{ secondsToHours(Object.values(wlByTicketReport.matrix[ticket] ?? {}).reduce((sum, m) => sum + (m[day] ?? 0), 0)) }}
                        </span>
                      </td>
                      <td class="total-cell">
                        {{ secondsToHours(wlByTicketReport.ticketTotals[ticket] ?? 0) }}h
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <el-empty v-else-if="wlByTicketReport && !wlByTicketReport.tickets.length" description="Không có dữ liệu logwork" :image-size="60" />
            <div v-else class="worklog-placeholder"><span>Chọn khoảng ngày và nhấn <b>Xem báo cáo</b>.</span></div>
          </template>
        </section>
      </el-tab-pane>

      <el-tab-pane name="resources">
        <template #label>
          <span class="jira-tab-label"
            ><i>⌁</i
            ><span
              ><b>Tài nguyên</b><small>{{ resources.length }} liên kết</small></span
            ></span
          >
        </template>
        <div class="resource-toolbar">
          <p>Chỉ lưu link và metadata, không tải nội dung tài liệu về local.</p>
          <el-button type="primary" @click="openResource()">+ Add resource</el-button>
        </div>
        <section class="jira-card">
          <el-table :data="resources" row-key="id"
            ><el-table-column label="Name" min-width="260"
              ><template #default="{ row }"
                ><a :href="row.url" target="_blank" rel="noreferrer"
                  ><b>{{ row.name }}</b></a
                ><small class="table-note">{{ row.description }}</small></template
              ></el-table-column
            ><el-table-column prop="type" label="Type" width="120" /><el-table-column
              prop="jiraKey"
              label="Related task"
              width="130"
            /><el-table-column prop="owner" label="Owner" width="150" /><el-table-column label="Visibility" width="120"
              ><template #default="{ row }"
                ><el-tag effect="plain">{{ row.visibility }}</el-tag></template
              ></el-table-column
            ><el-table-column width="120"
              ><template #default="{ row }"
                ><el-button text @click.stop="openResource(row)">Edit</el-button
                ><el-button text type="danger" @click.stop="removeResource(row)">Delete</el-button></template
              ></el-table-column
            ></el-table
          >
        </section>
      </el-tab-pane>

      <el-tab-pane name="settings">
        <template #label>
          <span class="jira-tab-label"
            ><i>⚙</i><span><b>Cấu hình</b><small>Kết nối và đồng bộ</small></span></span
          >
        </template>
        <section class="jira-setup">
          <div class="setup-heading">
            <div>
              <span class="eyebrow">CONNECTION CHECKLIST</span>
              <h3>Thiết lập Jira trong 3 bước</h3>
              <p>Cấu hình secret ở backend trước, sau đó khai báo phạm vi dữ liệu được phép đồng bộ.</p>
            </div>
            <div class="setup-progress">
              <strong
                >{{ configurationChecks.filter((item) => item.ready).length }}/{{ configurationChecks.length }}</strong
              >
              <span>mục đã sẵn sàng</span>
            </div>
          </div>
          <div class="setup-content">
            <div class="setup-steps">
              <article>
                <b>1</b
                ><span
                  ><strong>Backend credentials</strong
                  ><small>{{
                    settings.jiraType === 'cloud' ? 'API token + email Atlassian' : 'Personal Access Token (PAT)'
                  }}</small></span
                >
              </article>
              <article>
                <b>2</b
                ><span
                  ><strong>Quyền Jira read-only</strong
                  ><small>Service account cần Browse Projects trên các project được đồng bộ.</small></span
                >
              </article>
              <article>
                <b>3</b
                ><span
                  ><strong>Lưu và test kết nối thật</strong
                  ><small>Nhập JQL/allowlist, lưu cấu hình rồi gọi trực tiếp Jira để xác minh PAT.</small></span
                >
              </article>
            </div>
            <div class="env-example">
              <div><span>Backend environment</span><el-button text @click="copyEnvTemplate">Copy</el-button></div>
              <pre>{{ envTemplate }}</pre>
              <small>Restart API/Control Center sau khi thay đổi biến môi trường.</small>
            </div>
          </div>
          <div class="setup-checks">
            <span v-for="item in configurationChecks" :key="item.label" :class="{ ready: item.ready }"
              ><i>{{ item.ready ? '✓' : '!' }}</i
              >{{ item.label }}</span
            >
          </div>
          <el-alert
            v-if="connection"
            :title="`Đã kết nối ${connection.displayName} · ${connection.durationMs} ms`"
            type="success"
            show-icon
            :closable="false"
          />
        </section>
        <div class="jira-grid settings-grid">
          <section class="jira-card settings-form">
            <div class="jira-card-head">
              <div>
                <h3>Kết nối Jira</h3>
                <small>Token không được lưu trong trình duyệt hoặc MySQL</small>
              </div>
              <el-tag :type="settings.hasToken ? 'success' : 'warning'">{{
                settings.hasToken ? 'Secret configured' : 'Secret missing'
              }}</el-tag>
            </div>
            <el-form label-position="top"
              ><div class="form-two">
                <el-form-item label="Loại Jira"
                  ><el-select v-model="settings.jiraType"
                    ><el-option label="Jira Cloud" value="cloud" /><el-option
                      label="Jira Data Center"
                      value="data_center" /></el-select></el-form-item
                ><el-form-item label="Base URL"
                  ><el-input
                    v-model="settings.baseUrl"
                    :placeholder="
                      settings.jiraType === 'cloud' ? 'https://company.atlassian.net' : 'https://jira.company.internal'
                    "
                /></el-form-item>
              </div>
              <el-form-item label="Team JQL"
                ><el-input
                  v-model="settings.jql"
                  type="textarea"
                  :rows="3"
                  placeholder="project = MEMBER ORDER BY updated DESC"
                /><small class="field-help"
                  >JQL được lưu phía backend và không nhận trực tiếp từ màn hình Issues.</small
                ></el-form-item
              ><el-form-item label="Project keys được phép (phân cách bằng dấu phẩy)"
                ><el-input v-model="allowedProjectsText" placeholder="MEMBER, SUPPORT" /><small class="field-help"
                  >Đây là lớp bảo vệ bổ sung ngoài JQL.</small
                ></el-form-item
              >
              <div class="form-three">
                <el-form-item label="Chế độ sync"
                  ><el-select v-model="settings.syncMode"
                    ><el-option label="Manual" value="manual" /><el-option
                      label="Interval"
                      value="interval" /></el-select></el-form-item
                ><el-form-item label="Chu kỳ (phút)"
                  ><el-input-number v-model="settings.syncIntervalMinutes" :min="15" :max="1440" /></el-form-item
                ><el-form-item label="Cảnh báo stale (ngày)"
                  ><el-input-number v-model="settings.staleDays" :min="1" :max="365"
                /></el-form-item>
              </div>
              <el-button type="primary" @click="saveSettings">Lưu cấu hình</el-button
              ><el-button :loading="testingConnection" @click="testConnection"
                >Test kết nối trực tiếp</el-button
              ></el-form
            >
          </section>
          <section class="jira-card">
            <h3>Sync history</h3>
            <div v-for="run in syncRuns.slice(0, 8)" :key="run.id" class="history-row">
              <span
                ><b>{{ run.status }}</b
                ><small>{{ date(run.startedAt) }}</small></span
              ><em>+{{ run.createdCount }} / ~{{ run.updatedCount }} / ={{ run.unchangedCount }}</em>
            </div>
            <el-empty v-if="!syncRuns.length" description="Chưa có lần sync" :image-size="54" />
            <h3 class="audit-title">Audit log</h3>
            <div v-for="item in audits.slice(0, 8)" :key="item.id" class="history-row">
              <span
                ><b>{{ item.action }}</b
                ><small>{{ item.actor }} · {{ item.targetId }}</small></span
              ><em>{{ date(item.createdAt) }}</em>
            </div>
          </section>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- Issue Drawer -->
    <el-drawer v-model="issueDrawer" size="580px">
      <template #header>
        <div class="drawer-title">
          <span>{{ selectedIssue?.jiraKey }}</span>
          <h3>{{ selectedIssue?.summary }}</h3>
        </div>
      </template>
      <div v-if="selectedIssue" class="issue-detail">
        <el-tabs v-model="issueDetailTab" class="detail-tabs">
          <!-- TAB: Info -->
          <el-tab-pane label="Thông tin" name="info">
            <div class="detail-grid">
              <span>Status<b><el-tag :type="statusType(selectedIssue)">{{ selectedIssue.status }}</el-tag></b></span>
              <span>Assignee<b>{{ selectedIssue.assigneeName || 'Unassigned' }}</b></span>
              <span>Sprint<b>{{ selectedIssue.sprint || '—' }}</b></span>
              <span>Priority<b>{{ selectedIssue.priority || '—' }}</b></span>
              <span>Start date<b>{{ date(selectedIssue.startDate) }}</b></span>
              <span>Due date<b>{{ date(selectedIssue.dueDate) }}</b></span>
              <span class="detail-full">Parent
                <b v-if="selectedIssue.parentKey">
                  <a :href="`${settings.baseUrl}/browse/${selectedIssue.parentKey}`" target="_blank" rel="noreferrer" class="parent-link">{{ selectedIssue.parentKey }}</a>
                  <small>{{ selectedIssue.parentSummary }}</small>
                </b>
                <b v-else>—</b>
              </span>
              <span class="detail-full">Labels
                <b v-if="parseLabels(selectedIssue.labels).length">
                  <span v-for="lbl in parseLabels(selectedIssue.labels)" :key="lbl" class="label-chip">{{ lbl }}</span>
                </b>
                <b v-else>—</b>
              </span>
            </div>
            <p v-if="selectedIssue.description" class="description">{{ selectedIssue.description }}</p>
            <el-divider>Local metadata</el-divider>
            <el-form label-position="top">
              <el-form-item label="Internal category"><el-input v-model="metadata.internalCategory" /></el-form-item>
              <el-form-item label="Report note"><el-input v-model="metadata.reportNote" type="textarea" :rows="4" /></el-form-item>
              <el-form-item label="Block reason"><el-input v-model="metadata.blockReason" type="textarea" :rows="3" /></el-form-item>
              <div class="check-row">
                <el-checkbox v-model="metadata.highlight">Highlight</el-checkbox>
                <el-checkbox v-model="metadata.risk">Risk</el-checkbox>
              </div>
              <div class="drawer-actions">
                <a :href="jiraUrl(selectedIssue)" target="_blank" rel="noreferrer"><el-button>Open in Jira</el-button></a>
                <el-button type="primary" @click="saveMetadata">Save metadata</el-button>
              </div>
            </el-form>
          </el-tab-pane>

          <!-- TAB: Comments -->
          <el-tab-pane name="comments">
            <template #label>
              <span>Comments <el-badge v-if="issueComments.length" :value="issueComments.length" type="info" /></span>
            </template>
            <div v-loading="loadingDetail">
              <div v-if="issueComments.length" class="comments-list">
                <div v-for="c in issueComments" :key="c.id" class="comment-item">
                  <div class="comment-meta"><b>{{ c.authorName }}</b><span>{{ date(c.createdAtJira) }}</span></div>
                  <p class="comment-body">{{ c.body || '(no content)' }}</p>
                </div>
              </div>
              <el-empty v-else-if="!loadingDetail" description="Không có comment" :image-size="54" />
            </div>
          </el-tab-pane>

          <!-- TAB: Worklogs -->
          <el-tab-pane name="worklogs">
            <template #label>
              <span>Worklogs <el-badge v-if="issueWorklogs.length" :value="issueWorklogs.length" type="info" /></span>
            </template>
            <div v-loading="loadingDetail">
              <div v-if="issueWorklogs.length">
                <div class="worklog-total">
                  Tổng: <b>{{ secondsToHours(issueWorklogs.reduce((s, w) => s + w.timeSpentSeconds, 0)) }} giờ</b>
                </div>
                <div v-for="w in issueWorklogs" :key="w.id" class="worklog-item">
                  <div class="worklog-item-meta">
                    <span class="worklog-author">{{ w.authorName }}</span>
                    <span class="worklog-time">{{ secondsToHours(w.timeSpentSeconds) }}h</span>
                    <span class="worklog-date">{{ date(w.started) }}</span>
                  </div>
                  <p v-if="w.comment" class="worklog-comment">{{ w.comment }}</p>
                </div>
              </div>
              <el-empty v-else-if="!loadingDetail" description="Chưa có worklog" :image-size="54" />
            </div>
          </el-tab-pane>
        </el-tabs>
      </div>
    </el-drawer>

    <el-dialog v-model="resourceDialog" :title="editingResourceId ? 'Edit resource' : 'Add resource'" width="560px"
      ><el-form label-position="top"
        ><div class="form-two">
          <el-form-item label="Name"><el-input v-model="resourceForm.name" /></el-form-item
          ><el-form-item label="Type"
            ><el-select v-model="resourceForm.type"
              ><el-option
                v-for="type in ['Confluence', 'Drive', 'Document', 'Diagram', 'Runbook', 'Other']"
                :key="type"
                :value="type" /></el-select
          ></el-form-item>
        </div>
        <el-form-item label="URL"><el-input v-model="resourceForm.url" /></el-form-item>
        <div class="form-two">
          <el-form-item label="Related Jira key"
            ><el-input v-model="resourceForm.jiraKey" placeholder="Optional" /></el-form-item
          ><el-form-item label="Owner"><el-input v-model="resourceForm.owner" /></el-form-item>
        </div>
        <el-form-item label="Visibility"
          ><el-radio-group v-model="resourceForm.visibility"
            ><el-radio-button value="Team">Team</el-radio-button
            ><el-radio-button value="Restricted">Restricted</el-radio-button
            ><el-radio-button value="Private">Private</el-radio-button></el-radio-group
          ></el-form-item
        ><el-form-item label="Description"
          ><el-input v-model="resourceForm.description" type="textarea" :rows="3" /></el-form-item></el-form
      ><template #footer
        ><el-button @click="resourceDialog = false">Cancel</el-button
        ><el-button type="primary" @click="saveResource">Save</el-button></template
      ></el-dialog
    >
  </div>
</template>

<style scoped>
.jira-workspace {
  --jira-blue: #579dff;
}
.report-actions,
.resource-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
.report-actions p,
.resource-toolbar p {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}
.jira-tabs {
  margin-top: 0;
}
.jira-tabs :deep(.el-tabs__header) {
  margin: 0 0 16px;
  padding: 7px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: #0d1726;
  box-shadow: 0 10px 28px rgb(0 0 0 / 14%);
}
.jira-tabs :deep(.el-tabs__nav-wrap::after),
.jira-tabs :deep(.el-tabs__active-bar) {
  display: none;
}
.jira-tabs :deep(.el-tabs__nav) {
  display: flex;
  gap: 5px;
}
.jira-tabs :deep(.el-tabs__item) {
  height: auto;
  padding: 0;
  color: #9eacc0;
}
.jira-tab-label {
  display: flex;
  min-width: 126px;
  align-items: center;
  gap: 9px;
  padding: 9px 11px;
  border: 1px solid transparent;
  border-radius: 10px;
  transition: 160ms ease;
}
.jira-tab-label > i {
  display: grid;
  flex: 0 0 29px;
  height: 29px;
  place-items: center;
  border-radius: 8px;
  background: #182840;
  color: #91bfff;
  font-style: normal;
  font-size: 13px;
  font-weight: 800;
}
.jira-tab-label > span {
  display: grid;
  gap: 2px;
  text-align: left;
}
.jira-tab-label b {
  color: #d8e3f1;
  font-size: 11px;
  line-height: 1.2;
}
.jira-tab-label small {
  color: #788ba4;
  font-size: 9px;
  line-height: 1.2;
}
.jira-tabs :deep(.el-tabs__item:hover) .jira-tab-label {
  border-color: #2e4666;
  background: #142139;
}
.jira-tabs :deep(.el-tabs__item.is-active) .jira-tab-label {
  border-color: #376bb0;
  background: linear-gradient(135deg, #18365d, #182b49);
  box-shadow: inset 0 0 0 1px rgb(87 157 255 / 9%);
}
.jira-tabs :deep(.el-tabs__item.is-active) .jira-tab-label > i {
  background: #2463bd;
  color: white;
  box-shadow: 0 5px 14px rgb(36 99 189 / 30%);
}
.jira-tabs :deep(.el-tabs__item.is-active) .jira-tab-label b {
  color: white;
}
.jira-setup {
  margin-bottom: 14px;
  padding: 18px;
  border: 1px solid #2b507d;
  border-radius: 14px;
  background: linear-gradient(135deg, #10243e, #111b2b 62%);
}
.setup-heading,
.setup-content,
.setup-heading > div,
.setup-progress,
.setup-steps article,
.env-example > div,
.setup-checks {
  display: flex;
}
.setup-heading,
.env-example > div {
  align-items: center;
  justify-content: space-between;
}
.setup-heading > div,
.setup-progress {
  flex-direction: column;
}
.setup-heading h3 {
  margin: 4px 0;
  font-size: 18px;
}
.setup-heading p {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
}
.setup-progress {
  min-width: 105px;
  align-items: flex-end;
}
.setup-progress strong {
  color: #8bbdff;
  font-size: 24px;
}
.setup-progress span {
  color: var(--muted);
  font-size: 10px;
}
.setup-content {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(360px, 0.75fr);
  gap: 14px;
  margin-top: 16px;
}
.setup-steps {
  display: grid;
  gap: 7px;
}
.setup-steps article {
  align-items: center;
  gap: 11px;
  padding: 9px 11px;
  border: 1px solid #263a56;
  border-radius: 10px;
  background: rgb(8 17 31 / 45%);
}
.setup-steps article > b {
  display: grid;
  flex: 0 0 26px;
  height: 26px;
  place-items: center;
  border-radius: 50%;
  background: #245aa0;
  color: white;
  font-size: 11px;
}
.setup-steps article > span {
  display: grid;
  gap: 3px;
}
.setup-steps strong {
  font-size: 11px;
}
.setup-steps small {
  color: var(--muted);
  font-size: 10px;
}
.env-example {
  overflow: hidden;
  border: 1px solid #2b3f5b;
  border-radius: 11px;
  background: #070f1c;
}
.env-example > div {
  height: 38px;
  padding: 0 12px;
  border-bottom: 1px solid #263750;
  color: #a7b8cc;
  font-size: 10px;
  font-weight: 700;
}
.env-example pre {
  min-height: 72px;
  margin: 0;
  padding: 12px;
  color: #a9ddba;
  font:
    10px/1.7 SFMono-Regular,
    Consolas,
    monospace;
  white-space: pre-wrap;
}
.env-example > small {
  display: block;
  padding: 0 12px 11px;
  color: #d3a95c;
  font-size: 9px;
}
.setup-checks {
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 13px;
}
.setup-checks > span {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border: 1px solid #6e4a30;
  border-radius: 999px;
  background: #302217;
  color: #e7b36d;
  font-size: 9px;
  font-weight: 700;
}
.setup-checks > span.ready {
  border-color: #285a3d;
  background: #102d1e;
  color: #7ddda0;
}
.setup-checks i {
  font-style: normal;
}
.field-help {
  display: block;
  margin-top: 5px;
  color: var(--muted);
  font-size: 9px;
  line-height: 1.4;
}
.jira-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}
.jira-metrics article,
.jira-card,
.board-column {
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--panel);
  box-shadow: 0 14px 36px rgb(0 0 0 / 16%);
}
.jira-metrics article {
  padding: 17px;
}
.jira-metrics span,
.jira-metrics small {
  display: block;
  color: var(--muted);
  font-size: 11px;
}
.jira-metrics strong {
  display: block;
  margin: 8px 0;
  font-size: 28px;
}
.jira-metrics .danger strong {
  color: #ff8799;
}
.jira-metrics .success strong {
  color: #72e59a;
}
.jira-grid {
  display: grid;
  gap: 14px;
}
.dashboard-grid,
.report-grid,
.settings-grid {
  grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.65fr);
  margin-top: 14px;
}
.jira-card {
  overflow: hidden;
  padding: 16px;
}
.jira-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.jira-card h3 {
  margin: 0 0 14px;
  font-size: 16px;
}
.jira-card-head h3 {
  margin: 0;
}
.jira-card-head small {
  color: var(--muted);
}
.activity-row,
.resource-link {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 4px;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.activity-row span,
.resource-link span {
  display: grid;
  gap: 3px;
}
.activity-row b {
  color: #8bbdff;
  font-size: 11px;
}
.activity-row span {
  font-size: 12px;
}
.resource-link b {
  font-size: 12px;
}
.resource-link small,
.table-note {
  display: block;
  color: var(--muted);
  font-size: 10px;
}
.issue-filters {
  display: grid;
  grid-template-columns: minmax(230px, 1.5fr) repeat(4, minmax(120px, 1fr));
  gap: 8px;
  margin-bottom: 14px;
}
.issue-title {
  display: grid;
  gap: 4px;
}
.issue-title b {
  color: #8bbdff;
  font-size: 11px;
}
.issue-title span {
  font-weight: 650;
}
.board-filters {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.board-filters > * {
  max-width: 260px;
}
.jira-board {
  display: grid;
  grid-template-columns: repeat(3, minmax(250px, 1fr));
  gap: 12px;
  align-items: start;
}
.board-column {
  min-height: 370px;
  padding: 12px;
}
.board-column header {
  display: flex;
  justify-content: space-between;
  padding: 4px 4px 12px;
}
.board-column header span {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #21334f;
  color: #b7cae4;
  font-size: 11px;
}
.board-card {
  display: grid;
  width: 100%;
  gap: 10px;
  margin-bottom: 9px;
  padding: 13px;
  border: 1px solid #2b3b55;
  border-radius: 11px;
  background: #0d1726;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.board-card:hover {
  border-color: #4c77b6;
  transform: translateY(-1px);
}
.board-card > b {
  color: #8bbdff;
  font-size: 10px;
}
.board-card > strong {
  font-size: 12px;
  line-height: 1.45;
}
.board-card > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--muted);
  font-size: 10px;
}
.report-actions,
.resource-toolbar {
  margin-bottom: 12px;
}
.report-group {
  margin: 18px 0;
}
.report-group > div {
  display: flex;
  justify-content: space-between;
  margin-bottom: 7px;
  font-size: 12px;
}
.report-summary > div {
  display: flex;
  justify-content: space-between;
  padding: 9px 0;
  border-bottom: 1px solid var(--line);
}
.report-summary h4 {
  margin: 18px 0 8px;
}
.report-summary p {
  font-size: 12px;
  line-height: 1.5;
}
.report-summary p b {
  color: #8bbdff;
}
.settings-form :deep(.el-select),
.settings-form :deep(.el-input-number) {
  width: 100%;
}
.form-two,
.form-three {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.form-three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.history-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 0;
  border-bottom: 1px solid var(--line);
  font-size: 11px;
}
.history-row span {
  display: grid;
  gap: 4px;
}
.history-row small {
  color: var(--muted);
}
.history-row em {
  color: var(--muted);
  font-style: normal;
}
.audit-title {
  margin-top: 24px !important;
}
.drawer-title span {
  color: #8bbdff;
  font-size: 11px;
  font-weight: 800;
}
.drawer-title h3 {
  margin: 3px 0;
  max-width: 430px;
}
.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}
.detail-grid > span {
  display: grid;
  gap: 6px;
  padding: 11px;
  border: 1px solid var(--line);
  border-radius: 10px;
  color: var(--muted);
  font-size: 10px;
}
.detail-grid b {
  color: var(--text);
  font-size: 12px;
}
.description {
  padding: 13px;
  border-radius: 10px;
  background: #0d1726;
  color: #bfcbdb;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
}
.check-row,
.drawer-actions {
  display: flex;
  gap: 18px;
}
.drawer-actions {
  justify-content: flex-end;
  margin-top: 22px;
}
@media (max-width: 1150px) {
  .jira-metrics {
    grid-template-columns: repeat(2, 1fr);
  }
  .dashboard-grid,
  .report-grid,
  .settings-grid {
    grid-template-columns: 1fr;
  }
  .setup-content {
    grid-template-columns: 1fr;
  }
  .issue-filters {
    grid-template-columns: repeat(2, 1fr);
  }
  .jira-board {
    overflow: auto;
    grid-template-columns: repeat(3, 280px);
  }
}
@media (max-width: 700px) {
  .report-actions,
  .resource-toolbar,
  .setup-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .setup-progress {
    align-items: flex-start;
  }
  .jira-tab-label {
    min-width: auto;
    padding: 8px;
  }
  .jira-tab-label small {
    display: none;
  }
  .jira-metrics,
  .issue-filters,
  .form-two,
  .form-three {
    grid-template-columns: 1fr;
  }
  .board-filters {
    flex-direction: column;
  }
  .board-filters > * {
    max-width: none;
  }
  .detail-grid {
    grid-template-columns: 1fr;
  }
}

/* ── New field styles ── */
.label-chip {
  display: inline-block;
  margin: 1px 3px 1px 0;
  padding: 2px 7px;
  border-radius: 999px;
  background: #1e3352;
  color: #8bbdff;
  font-size: 10px;
  font-weight: 700;
}
.parent-chip {
  padding: 2px 7px;
  border-radius: 6px;
  background: #192f4d;
  color: #72aeff;
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}
.parent-link {
  color: #72aeff;
  text-decoration: none;
  font-weight: 700;
}
.parent-link:hover {
  text-decoration: underline;
}
.text-muted {
  color: var(--muted);
}
/* Detail grid extensions */
.detail-full {
  grid-column: 1 / -1;
}
.detail-full b {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
}
.detail-full b small {
  color: var(--muted);
  font-size: 10px;
  font-weight: 400;
}
/* Detail tabs */
.detail-tabs {
  margin-bottom: 4px;
}
/* Comments */
.comments-list {
  display: grid;
  gap: 10px;
  margin-top: 4px;
}
.comment-item {
  padding: 11px 13px;
  border-radius: 10px;
  background: #0d1726;
  border: 1px solid #1e3352;
}
.comment-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.comment-meta b {
  color: #8bbdff;
  font-size: 11px;
}
.comment-meta span {
  color: var(--muted);
  font-size: 10px;
}
.comment-body {
  margin: 0;
  color: #bfcbdb;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
}
/* Worklogs */
.worklog-total {
  padding: 10px 0 12px;
  color: var(--muted);
  font-size: 12px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 10px;
}
.worklog-total b {
  color: #72e59a;
}
.worklog-item {
  padding: 9px 0;
  border-bottom: 1px solid var(--line);
}
.worklog-item-meta {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 4px;
}
.worklog-author {
  color: #8bbdff;
  font-size: 12px;
  font-weight: 700;
  flex: 1;
}
.worklog-time {
  color: #72e59a;
  font-size: 12px;
  font-weight: 700;
}
.worklog-date {
  color: var(--muted);
  font-size: 10px;
}
.worklog-comment {
  margin: 0 0 0 2px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
}
/* ── Worklog Report ── */
.worklog-report-card {
  margin-top: 14px;
}
.worklog-report-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}
.worklog-report-header h3 {
  margin: 0 0 3px;
}
.worklog-report-header small {
  color: var(--muted);
  font-size: 10px;
}
.worklog-report-controls {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.worklog-legend {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
  font-size: 10px;
  color: var(--muted);
}
.legend-dot {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 4px;
  color: #cce;
  font-size: 10px;
  font-weight: 700;
}
.worklog-matrix-wrap {
  overflow-x: auto;
}
.worklog-matrix {
  min-width: 100%;
}
.wl-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.wl-table th {
  padding: 6px 8px;
  background: #0d1726;
  color: #6a85a8;
  font-weight: 700;
  text-align: center;
  white-space: nowrap;
  border: 1px solid #1b2f4a;
}
.member-col {
  text-align: left !important;
  min-width: 130px;
  position: sticky;
  left: 0;
  z-index: 1;
}
.total-col {
  background: #0f1e33 !important;
  color: #8bbdff !important;
  min-width: 64px;
}
.day-col {
  min-width: 52px;
}
.member-name {
  padding: 6px 10px;
  background: #0d1726;
  color: #c5d5e8;
  font-weight: 700;
  white-space: nowrap;
  border: 1px solid #1b2f4a;
  position: sticky;
  left: 0;
  z-index: 1;
}
.wl-cell {
  width: 52px;
  height: 34px;
  text-align: center;
  border: 1px solid #111c2c;
  transition: transform 100ms;
  cursor: default;
  color: #cce8d8;
  font-size: 10px;
  font-weight: 700;
}
.wl-cell:hover {
  outline: 2px solid #4c9eff;
  outline-offset: -2px;
  transform: scale(1.1);
  z-index: 2;
  position: relative;
}
.total-cell {
  padding: 6px 10px;
  background: #0f1e33;
  color: #8bbdff;
  font-weight: 700;
  text-align: center;
  border: 1px solid #1b2f4a;
  white-space: nowrap;
}
.worklog-placeholder {
  padding: 28px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
  border: 1px dashed #2a3f5e;
  border-radius: 10px;
}
.worklog-placeholder b {
  color: #8bbdff;
}
/* Worklog mode group */
.wl-mode-group {
  flex-shrink: 0;
}
.wl-controls-bar {
  margin-bottom: 12px;
  flex-wrap: wrap;
}
/* Ticket-based worklog table */
.wl-ticket-table .ticket-key-cell {
  padding: 8px 10px;
  background: #0d1726;
  color: #8bbdff;
  font-weight: 700;
  border: 1px solid #1b2f4a;
  vertical-align: middle;
  white-space: nowrap;
  text-align: left;
}
.wl-ticket-table .ticket-key-cell b {
  display: block;
  font-size: 12px;
  color: #579dff;
}
.ticket-total-badge {
  display: inline-block;
  margin-top: 3px;
  background: #132340;
  color: #72e59a;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 700;
}
.ticket-first-row td {
  border-top: 2px solid #253a5e;
}
</style>
