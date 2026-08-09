<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from '../ui';
import { api, post } from '../api';

type Issue = {
  jiraId: string;
  jiraKey: string;
  projectKey: string;
  summary: string;
  description?: string;
  issueType?: string;
  status: string;
  statusCategory: string;
  statusColor?: string;
  assigneeName?: string;
  priority?: string;
  sprint?: string;
  dueDate?: string;
  parentKey?: string;
  parentSummary?: string;
  labels?: string; // JSON array string
  startDate?: string;
  customFields?: string; // JSON object keyed by Jira field id
  jiraUpdatedAt: string;
  syncedAt: string;
  reportNote?: string;
  internalCategory?: string;
  blockReason?: string;
  highlight: number | boolean;
  risk: number | boolean;
};
type CustomFieldDefinition = { id: string; label: string; path: string; role?: 'sprint' };
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
  customFields?: CustomFieldDefinition[];
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
const dashboard = ref<any>({ metrics: {}, recentIssues: [] });
const report = ref<Report>({
  groups: [],
  done: [],
  inProgress: [],
  blocked: [],
});
const syncRuns = ref<any[]>([]);
const audits = ref<any[]>([]);
const filters = reactive({ q: '', status: '', assignee: '', priority: '', sprint: '' });
const boardDueStatus = ref('');
const dueStatusOptions = [
  { value: 'on-track', label: 'On track', hint: 'Due in 3+ days', icon: 'mdi-circle' },
  { value: 'due-soon', label: 'Due soon', hint: 'Due in 1–2 days', icon: 'mdi-clock-outline' },
  { value: 'due-today', label: 'Due today', hint: '', icon: 'mdi-clock-alert-outline' },
  { value: 'overdue', label: 'Overdue', hint: '', icon: 'mdi-fire' },
  { value: 'overdue-severe', label: 'Overdue 3+ days', hint: '', icon: 'mdi-fire' },
  { value: 'no-due', label: 'No due date', hint: '', icon: 'mdi-calendar-blank-outline' },
];
// Issue drawer detail data
const issueComments = ref<Comment[]>([]);
const issueWorklogs = ref<Worklog[]>([]);
const issueDetailTab = ref('info');
const loadingDetail = ref(false);
const worklogMode = ref<'by-day' | 'by-ticket'>('by-day');
const wlDateFrom = ref(new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
const wlDateTo = ref(new Date().toISOString().slice(0, 10));
const wlAuthorFilter = ref('');
const wlTicketFilter = ref('');
const wlTicketSearch = ref('');
const wlLoading = ref(false);
const wlMemberReport = ref<WorklogReport | null>(null);
const wlByTicketReport = ref<WorklogByTicketReport | null>(null);
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

const unique = (key: keyof Issue) =>
  [...new Set(issues.value.map((item) => String(item[key] ?? '')).filter(Boolean))].sort();
const statusOptions = computed(() => unique('status'));
const assigneeOptions = computed(() => unique('assigneeName'));
const priorityOptions = computed(() => unique('priority'));
const sprintOptions = computed(() => unique('sprint'));
const parentOptions = computed(() =>
  [...new Set(issues.value.filter((i) => i.parentKey).map((i) => i.parentKey!))].sort()
);
const wlTicketOptions = computed(() =>
  [...new Set([...issues.value.map((issue) => issue.jiraKey), ...wlKnownTickets.value])].sort()
);
const filteredWlTicketOptions = computed(() => {
  const query = wlTicketSearch.value.trim().toLowerCase();
  return query ? wlTicketOptions.value.filter((ticket) => ticket.toLowerCase().includes(query)) : wlTicketOptions.value;
});
function parseLabels(labels?: string): string[] {
  if (!labels) return [];
  try {
    return JSON.parse(labels);
  } catch {
    return [];
  }
}
const envTemplate = computed(() =>
  settings.jiraType === 'cloud'
    ? `JIRA_TYPE=cloud\nJIRA_BASE_URL=${settings.baseUrl || 'https://company.atlassian.net'}\nJIRA_INTERNAL_URL=\nJIRA_API_TOKEN=<atlassian-api-token>\nJIRA_EMAIL=<jira-account-email>\nJIRA_CUSTOM_FIELDS=[]\nJIRA_REQUEST_TIMEOUT_MS=15000`
    : `JIRA_TYPE=data_center\nJIRA_BASE_URL=${settings.baseUrl || 'https://jira.company.internal'}\nJIRA_INTERNAL_URL=\nJIRA_API_TOKEN=<jira-data-center-pat>\nJIRA_EMAIL=\nJIRA_CUSTOM_FIELDS=[]\nJIRA_REQUEST_TIMEOUT_MS=15000`
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
const sortedIssues = computed(() => [...filteredIssues.value].sort(compareIssues));
const boardVisibleIssues = computed(() =>
  sortedIssues.value.filter((issue) => !boardDueStatus.value || boardWarning(issue).tone === boardDueStatus.value)
);
const isReviewIssue = (issue: Issue) => /\breview\b/i.test(issue.status);
const boardColumns = computed(() => {
  const order = ['new', 'indeterminate', 'review', 'done'];
  const labels: Record<string, string> = {
    new: 'To do',
    indeterminate: 'In progress',
    review: 'In review',
    done: 'Done',
  };
  return order.map((category) => {
    const columnIssues = boardVisibleIssues.value.filter((issue) => {
      if (category === 'review') return issue.statusCategory === 'indeterminate' && isReviewIssue(issue);
      return issue.statusCategory === category && (category !== 'indeterminate' || !isReviewIssue(issue));
    });
    return { category, label: labels[category], issues: columnIssues, dueSummary: columnDueSummary(columnIssues) };
  });
});
const overviewStatusItems = computed(() => {
  const toDo = issues.value.filter((issue) => issue.statusCategory === 'new').length;
  const inReview = issues.value.filter(
    (issue) => issue.statusCategory === 'indeterminate' && isReviewIssue(issue)
  ).length;
  const inProgress = issues.value.filter(
    (issue) => issue.statusCategory === 'indeterminate' && !isReviewIssue(issue)
  ).length;
  const done = issues.value.filter((issue) => issue.statusCategory === 'done').length;
  return [
    { label: 'To do', count: toDo, color: '#94a3b8', tone: 'todo' },
    { label: 'In progress', count: inProgress, color: '#579dff', tone: 'in-progress' },
    { label: 'In review', count: inReview, color: '#a78bfa', tone: 'in-review' },
    { label: 'Done', count: done, color: '#4ade80', tone: 'done' },
  ];
});
const overviewStatusTotal = computed(() => overviewStatusItems.value.reduce((sum, item) => sum + item.count, 0));
const overviewStatusBackground = computed(() => {
  if (!overviewStatusTotal.value) return '#334155';
  let start = 0;
  const segments = overviewStatusItems.value.map((item) => {
    const end = start + (item.count / overviewStatusTotal.value) * 100;
    const segment = `${item.color} ${start}% ${end}%`;
    start = end;
    return segment;
  });
  return `conic-gradient(${segments.join(', ')})`;
});

function statusTone(issue: Issue) {
  if (issue.statusCategory === 'new' || /\bto[ -]?do\b/i.test(issue.status)) return 'todo';
  if (issue.statusCategory === 'done') return 'done';
  const color = issue.statusColor?.toLowerCase();
  if (color === 'green') return 'done';
  if (color === 'blue') return 'in-progress';
  if (color === 'yellow') return 'warning';
  if (color === 'red') return 'blocked';
  if (issue.statusCategory === 'indeterminate') return 'in-progress';
  if (issue.status.toLowerCase().includes('block')) return 'blocked';
  return 'todo';
}
function dueDateSortValue(value?: string | Date | null) {
  if (!value) return Number.MAX_SAFE_INTEGER;
  if (value instanceof Date) return value.getTime();
  const text = String(value);
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime();
  const timestamp = new Date(text).getTime();
  return Number.isNaN(timestamp) ? Number.MAX_SAFE_INTEGER : timestamp;
}
function prioritySortValue(priority?: string) {
  const value = String(priority ?? '').trim().toLowerCase();
  if (/(highest|critical|blocker|urgent|p1)/.test(value)) return 0;
  if (/(^|\s)(high|major|p2)(\s|$)/.test(value)) return 1;
  if (/(medium|normal|p3)/.test(value)) return 2;
  if (/(lowest|trivial|p5)/.test(value)) return 4;
  if (/(low|minor|p4)/.test(value)) return 3;
  return 5;
}
function compareIssues(first: Issue, second: Issue) {
  const dueDifference = dueDateSortValue(first.dueDate) - dueDateSortValue(second.dueDate);
  if (dueDifference) return dueDifference;
  const priorityDifference = prioritySortValue(first.priority) - prioritySortValue(second.priority);
  return priorityDifference || first.jiraKey.localeCompare(second.jiraKey);
}
type BoardWarningTone = 'complete' | 'no-due' | 'on-track' | 'due-soon' | 'due-today' | 'overdue' | 'overdue-severe';
type BoardWarning = { tone: BoardWarningTone; icon: string; cornerIcon: string; label: string };
type BoardDueSummary = { tone: 'overdue' | 'due-soon'; icon: string; label: string; count: number };
function daysUntilDue(dueDate?: string | Date | null) {
  if (!dueDate) return null;
  const dueTimestamp = dueDateSortValue(dueDate);
  if (dueTimestamp === Number.MAX_SAFE_INTEGER) return null;
  const due = new Date(dueTimestamp);
  const today = new Date();
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - today.getTime()) / 86_400_000);
}
function boardWarning(issue: Issue): BoardWarning {
  if (issue.statusCategory === 'done') {
    return { tone: 'complete', icon: '✓', cornerIcon: 'mdi-check', label: 'Completed' };
  }
  const days = daysUntilDue(issue.dueDate);
  if (days === null) return { tone: 'no-due', icon: '📅', cornerIcon: 'mdi-calendar-blank-outline', label: 'No due date' };
  if (days <= -3) return { tone: 'overdue-severe', icon: '🔥', cornerIcon: 'mdi-fire', label: `Overdue ${Math.abs(days)}d` };
  if (days < 0) return { tone: 'overdue', icon: '🔥', cornerIcon: 'mdi-fire', label: `Overdue ${Math.abs(days)}d` };
  if (days === 0) return { tone: 'due-today', icon: '⏰', cornerIcon: 'mdi-clock-outline', label: 'Due today' };
  if (days <= 2) return { tone: 'due-soon', icon: '⏰', cornerIcon: 'mdi-clock-outline', label: days === 1 ? 'Due tomorrow' : 'Due in 2d' };
  return { tone: 'on-track', icon: '📅', cornerIcon: 'mdi-calendar-blank-outline', label: `Due in ${days}d` };
}
function columnDueSummary(columnIssues: Issue[]): BoardDueSummary[] {
  const overdueCount = columnIssues.filter((issue) => {
    const tone = boardWarning(issue).tone;
    return tone === 'overdue' || tone === 'overdue-severe';
  }).length;
  const dueSoonCount = columnIssues.filter((issue) => {
    const tone = boardWarning(issue).tone;
    return tone === 'due-today' || tone === 'due-soon';
  }).length;
  return [
    ...(overdueCount ? [{ tone: 'overdue' as const, icon: '🔥', label: 'overdue', count: overdueCount }] : []),
    ...(dueSoonCount ? [{ tone: 'due-soon' as const, icon: '⏰', label: 'due soon', count: dueSoonCount }] : []),
  ];
}
function deliveryCompletion(group: Report['groups'][number]) {
  return group.total ? Math.round((group.done / group.total) * 100) : 0;
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
function jiraUrl(issue: Issue | string) {
  const jiraKey = typeof issue === 'string' ? issue : issue.jiraKey;
  return `${settings.baseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(jiraKey)}`;
}
function parseCustomFields(value?: string): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function customFieldValue(issue: Issue | null | undefined, field: CustomFieldDefinition) {
  return issue ? parseCustomFields(issue.customFields)[field.id] || '—' : '—';
}
function isSprintField(field: CustomFieldDefinition) {
  return field.role === 'sprint' || /^sprints?$/i.test(field.label.trim());
}

async function loadAll() {
  loading.value = true;
  try {
    const [dashboardData, issueData, settingsData, reportData, runData, auditData] = await Promise.all([
      api<any>('/jira/dashboard'),
      api<{ rows: Issue[] }>('/jira/issues'),
      api<Settings>('/jira/settings'),
      api<Report>('/jira/reports/weekly'),
      api<{ rows: any[] }>('/jira/sync-runs'),
      api<{ rows: any[] }>('/jira/audit'),
    ]);
    dashboard.value = dashboardData;
    issues.value = issueData.rows;
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

async function copyEnvTemplate() {
  await navigator.clipboard.writeText(envTemplate.value);
  ElMessage.success('Đã copy mẫu biến môi trường');
}

async function loadActiveWorklog() {
  wlLoading.value = true;
  try {
    if (worklogMode.value === 'by-day') {
      const authorParam = wlAuthorFilter.value ? `&authorName=${encodeURIComponent(wlAuthorFilter.value)}` : '';
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
    const dayTotals = days.map((d) => Object.values(matrix[ticket] ?? {}).reduce((sum, m) => sum + (m[d] ?? 0), 0));
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
        <v-chip size="small" :color="settings.hasToken ? 'success' : 'warning'" variant="tonal">
          {{ settings.hasToken ? 'Token OK' : 'Token missing' }}
        </v-chip>
        <v-btn
          v-if="settings.baseUrl"
          size="small"
          :href="settings.baseUrl"
          target="_blank"
          append-icon="mdi-open-in-new"
          >Open Jira</v-btn
        >
        <v-btn size="small" color="primary" prepend-icon="mdi-sync" :loading="syncing" @click="syncJira"> Sync </v-btn>
      </div>
    </Teleport>

    <Teleport to="#topbar-page-tabs">
      <div class="jira-topbar-tabs">
        <v-btn
          size="small"
          variant="text"
          :class="{ 'is-active': activeTab === 'dashboard' }"
          @click="activeTab = 'dashboard'"
          ><span class="jira-topbar-tab-icon">⌂</span>Tổng quan</v-btn
        >
        <v-btn
          size="small"
          variant="text"
          :class="{ 'is-active': activeTab === 'issues' }"
          @click="activeTab = 'issues'"
          ><span class="jira-topbar-tab-icon">✓</span>Issues</v-btn
        >
        <v-btn size="small" variant="text" :class="{ 'is-active': activeTab === 'board' }" @click="activeTab = 'board'"
          ><span class="jira-topbar-tab-icon">▦</span>Board</v-btn
        >
        <v-btn
          size="small"
          variant="text"
          :class="{ 'is-active': activeTab === 'reports' }"
          @click="activeTab = 'reports'"
          ><span class="jira-topbar-tab-icon">↗</span>Worklog report</v-btn
        >
        <v-btn
          size="small"
          variant="text"
          :class="{ 'is-active': activeTab === 'settings' }"
          @click="activeTab = 'settings'"
          ><span class="jira-topbar-tab-icon">⚙</span>Cấu hình</v-btn
        >
      </div>
    </Teleport>

    <section class="jira-shell">
      <el-tabs v-model="activeTab" class="jira-tabs">
        <el-tab-pane name="dashboard">
          <template #label>
            <span class="jira-tab-label"
              ><i>⌂</i><span><b>Tổng quan</b></span></span
            >
          </template>
          <div class="jira-metrics">
            <article>
              <span>Open tasks</span><strong>{{ dashboard.metrics.open ?? 0 }}</strong
              ><small>{{ dashboard.metrics.stale ?? 0 }} task không cập nhật quá {{ settings.staleDays }} ngày</small>
            </article>
            <article>
              <span>In progress</span><strong>{{ dashboard.metrics.inProgress ?? 0 }}</strong>
            </article>
            <article class="danger">
              <span>Blocked</span><strong>{{ dashboard.metrics.blocked ?? 0 }}</strong
              ><small>{{ dashboard.metrics.overdue ?? 0 }} task quá hạn</small>
            </article>
            <article class="success">
              <span>Done this week</span><strong>{{ dashboard.metrics.doneThisWeek ?? 0 }}</strong>
            </article>
          </div>
          <div class="jira-grid dashboard-overview-grid">
            <section class="jira-card status-overview-card">
              <div class="jira-card-head">
                <div>
                  <h3>Tiến độ công việc</h3>
                  <small>Phân bổ issue theo trạng thái</small>
                </div>
              </div>
              <div class="status-overview-content">
                <div class="status-donut" :style="{ background: overviewStatusBackground }">
                  <div><strong>{{ overviewStatusTotal }}</strong><span>issues</span></div>
                </div>
                <div class="status-chart-legend">
                  <div v-for="item in overviewStatusItems" :key="item.label">
                    <span :style="{ background: item.color }"></span><b>{{ item.label }}</b><strong>{{ item.count }}</strong>
                  </div>
                </div>
              </div>
            </section>
            <section class="jira-card delivery-overview-card">
              <div class="jira-card-head">
                <div>
                  <h3>Team delivery</h3>
                  <small>Tiến độ hoàn thành theo nhóm</small>
                </div>
              </div>
              <div v-if="report.groups.length" class="delivery-chart">
                <div v-for="group in report.groups" :key="group.name" class="delivery-chart-row">
                  <div><span>{{ group.name }}</span><b>{{ group.done }}/{{ group.total }}</b></div>
                  <div class="delivery-chart-track"><span :style="{ width: `${deliveryCompletion(group)}%` }"></span></div>
                </div>
              </div>
              <el-empty v-else description="Chưa có dữ liệu delivery" :image-size="44" />
            </section>
          </div>
          <div class="jira-grid dashboard-grid dashboard-grid--single">
            <section class="jira-card">
              <div class="jira-card-head">
                <div>
                  <h3>Recently updated</h3>
                </div>
                <v-btn size="small" variant="text" append-icon="mdi-arrow-right" @click="activeTab = 'issues'"
                  >View all</v-btn
                >
              </div>
              <article
                v-for="issue in dashboard.recentIssues"
                :key="issue.jiraKey"
                class="activity-row"
                role="button"
                tabindex="0"
                @click="openIssue(issue)"
                @keydown.enter="openIssue(issue)"
              >
                <span
                  ><a class="jira-ticket-link" :href="jiraUrl(issue)" target="_blank" rel="noreferrer" @click.stop>{{
                    issue.jiraKey
                  }}</a
                  >{{ issue.summary }}</span
                ><el-tag size="small" class="jira-status" :class="`jira-status--${statusTone(issue)}`">{{
                  issue.status
                }}</el-tag>
              </article>
            </section>
          </div>
        </el-tab-pane>

        <el-tab-pane name="issues" class="issues-pane">
          <template #label>
            <span class="jira-tab-label"
              ><i>✓</i><span><b>Issues</b></span></span
            >
          </template>
          <section class="jira-card issues-card">
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
            <el-table
              class="issues-table"
              :data="sortedIssues"
              height="calc(100vh - 286px)"
              row-key="jiraKey"
              @row-click="openIssue"
            >
              <el-table-column label="Issue" min-width="300"
                ><template #default="{ row }"
                  ><div class="issue-title">
                    <a class="jira-ticket-link" :href="jiraUrl(row)" target="_blank" rel="noreferrer" @click.stop>{{
                      row.jiraKey
                    }}</a
                    ><span>{{ row.summary }}</span>
                  </div></template
                ></el-table-column
              >
              <el-table-column label="Status" width="140"
                ><template #default="{ row }"
                  ><el-tag class="jira-status" :class="`jira-status--${statusTone(row)}`">{{
                    row.status
                  }}</el-tag></template
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
              <el-table-column label="Priority" width="110"
                ><template #default="{ row }">{{ row.priority || '—' }}</template></el-table-column
              >
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
              <el-table-column
                v-for="field in (settings.customFields || []).filter((field) => !isSprintField(field))"
                :key="field.id"
                :label="field.label"
                min-width="150"
              >
                <template #default="{ row }">{{ customFieldValue(row, field) }}</template>
              </el-table-column>
            </el-table>
          </section>
        </el-tab-pane>

        <el-tab-pane name="board" class="board-pane">
          <template #label>
            <span class="jira-tab-label"
              ><i>▦</i><span><b>Board</b></span></span
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
            <el-select v-model="boardDueStatus" clearable placeholder="Due date status">
              <el-option
                v-for="item in dueStatusOptions"
                :key="item.value"
                :label="item.hint ? `${item.label} · ${item.hint}` : item.label"
                :value="item.value"
              >
                <span class="due-filter-option" :class="`due-filter-option--${item.value}`">
                  <v-icon :icon="item.icon" size="13" />
                  <b>{{ item.label }}</b>
                  <small v-if="item.hint">{{ item.hint }}</small>
                </span>
              </el-option>
            </el-select>
          </div>
          <div class="board-warning-legend" aria-label="Chú thích cảnh báo hạn công việc">
            <span class="board-warning board-warning--on-track"><i>●</i> On track</span>
            <span class="board-warning board-warning--due-soon"><i>◷</i> Due in 1–2 days</span>
            <span class="board-warning board-warning--due-today"><i>◷</i> Due today</span>
            <span class="board-warning board-warning--overdue"><i>🔥</i> Overdue</span>
            <span class="board-warning board-warning--overdue-severe"><i>🔥</i> Overdue 3+ days</span>
            <span class="board-warning board-warning--no-due"><i>▣</i> No due date</span>
          </div>
          <div class="jira-board">
            <section v-for="column in boardColumns" :key="column.category" class="board-column">
              <header>
                <div class="board-column-title">
                  <b>{{ column.label }}</b>
                  <span class="board-column-count" :aria-label="`${column.issues.length} issues`">{{ column.issues.length }}</span>
                </div>
                <div v-if="column.dueSummary.length" class="board-column-summary">
                  <span
                    v-for="summary in column.dueSummary"
                    :key="summary.tone"
                    class="board-column-summary-chip"
                    :class="`board-column-summary-chip--${summary.tone}`"
                    >{{ summary.icon }} {{ summary.count }} {{ summary.label }}</span
                  >
                </div>
              </header>
              <article
                v-for="issue in column.issues"
                :key="issue.jiraKey"
                class="board-card"
                :class="`board-card--${boardWarning(issue).tone}`"
                role="button"
                tabindex="0"
                @click="openIssue(issue)"
                @keydown.enter="openIssue(issue)"
              >
                <div class="board-card-head">
                  <a class="jira-ticket-link" :href="jiraUrl(issue)" target="_blank" rel="noreferrer" @click.stop>{{
                    issue.jiraKey
                  }}</a>
                  <span
                    v-if="boardWarning(issue).tone !== 'complete'"
                    class="board-card-alert-icon"
                    :class="`board-warning--${boardWarning(issue).tone}`"
                    :title="boardWarning(issue).label"
                  >
                    <span
                      v-if="boardWarning(issue).tone === 'overdue' || boardWarning(issue).tone === 'overdue-severe'"
                      class="board-fire-art"
                      :class="{ 'board-fire-art--heavy': boardWarning(issue).tone === 'overdue-severe' }"
                    >
                      <svg
                        v-if="boardWarning(issue).tone === 'overdue-severe'"
                        class="board-fire-outline"
                        viewBox="0 0 1200 1200"
                        aria-hidden="true"
                      >
                        <defs>
                          <linearGradient :id="`board-fire-outer-${issue.jiraKey}`" x1="600" y1="0" x2="600" y2="1200" gradientUnits="userSpaceOnUse">
                            <stop offset="0" stop-color="#fff1b3" stop-opacity=".98" />
                            <stop offset=".38" stop-color="#ffe18c" stop-opacity=".92" />
                            <stop offset=".72" stop-color="#ffc294" stop-opacity=".68" />
                            <stop offset="1" stop-color="#ffb0a2" stop-opacity=".30" />
                          </linearGradient>
                        </defs>
                        <path
                          :fill="`url(#board-fire-outer-${issue.jiraKey})`"
                          d="M381.63997 1200C135.77919 1061.434 71.049038 930.27865 108.05732 751.14866 135.37841 618.87726 224.83888 511.26304 233.417 379.24524c38.21484 69.54421 54.18284 119.69156 58.45336 192.36374C413.41348 422.69507 493.73121 216.54632 498.48692 0c0 0 316.57523 186.01008 337.34836 466.98023 27.25312-57.91289 40.97132-149.89172 13.7182-209.5043C931.31098 317.09086 1409.8464 846.31428 784.73519 1200 902.263 971.16186 815.05535 662.38827 610.99652 519.78234c13.62748 61.31866-10.26552 290.02046-100.54218 390.51421 25.01266-167.915-23.80054-238.91821-23.80054-238.91821s-16.75337 94.05444-81.7575 189.06609C345.53708 947.20639 304.40709 1039.2914 381.63997 1200Z"
                        />
                      </svg>
                      <svg class="board-fire-flame" viewBox="0 0 1200 1200" aria-hidden="true">
                        <defs>
                          <linearGradient :id="`board-fire-inner-${issue.jiraKey}`" x1="600" y1="0" x2="600" y2="1200" gradientUnits="userSpaceOnUse">
                            <stop offset="0" stop-color="#ffd54a" />
                            <stop offset=".28" stop-color="#ffb833" />
                            <stop offset=".62" stop-color="#ff6b43" />
                            <stop offset="1" stop-color="#c81e2b" />
                          </linearGradient>
                        </defs>
                        <path
                          :fill="`url(#board-fire-inner-${issue.jiraKey})`"
                          d="M381.63997 1200C135.77919 1061.434 71.049038 930.27865 108.05732 751.14866 135.37841 618.87726 224.83888 511.26304 233.417 379.24524c38.21484 69.54421 54.18284 119.69156 58.45336 192.36374C413.41348 422.69507 493.73121 216.54632 498.48692 0c0 0 316.57523 186.01008 337.34836 466.98023 27.25312-57.91289 40.97132-149.89172 13.7182-209.5043C931.31098 317.09086 1409.8464 846.31428 784.73519 1200 902.263 971.16186 815.05535 662.38827 610.99652 519.78234c13.62748 61.31866-10.26552 290.02046-100.54218 390.51421 25.01266-167.915-23.80054-238.91821-23.80054-238.91821s-16.75337 94.05444-81.7575 189.06609C345.53708 947.20639 304.40709 1039.2914 381.63997 1200Z"
                        />
                      </svg>
                      <template v-if="boardWarning(issue).tone === 'overdue-severe'">
                        <i class="board-fire-spark board-fire-spark--1"></i>
                        <i class="board-fire-spark board-fire-spark--2"></i>
                        <i class="board-fire-spark board-fire-spark--3"></i>
                        <i class="board-fire-spark board-fire-spark--4"></i>
                        <i class="board-fire-spark board-fire-spark--5"></i>
                      </template>
                    </span>
                    <svg
                      v-else-if="boardWarning(issue).tone === 'due-soon' || boardWarning(issue).tone === 'due-today'"
                      class="board-clock-art"
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 7v5l3 2" />
                    </svg>
                    <v-icon v-else :icon="boardWarning(issue).cornerIcon" size="16" />
                  </span>
                </div>
                <strong>{{ issue.summary }}</strong>
                <div class="board-card-meta">
                  <div class="board-card-meta-chips">
                    <el-tag size="small" class="jira-status" :class="`jira-status--${statusTone(issue)}`">{{
                      issue.status
                    }}</el-tag>
                    <span class="board-card-due-chip" :class="`board-card-due-chip--${boardWarning(issue).tone}`">
                      <i>{{ boardWarning(issue).icon }}</i>{{ boardWarning(issue).label }}
                    </span>
                  </div>
                  <span class="board-assignee">{{ issue.assigneeName || 'Unassigned' }}</span>
                </div>
              </article>
            </section>
          </div>
        </el-tab-pane>

        <el-tab-pane name="reports">
          <template #label>
            <span class="jira-tab-label"
              ><i>↗</i><span><b>Worklog report</b></span></span
            >
          </template>
          <section class="jira-card worklog-report-card">
            <div class="worklog-report-header">
              <div>
                <h3>Worklog report</h3>
                <small>Tổng giờ làm việc theo dữ liệu Jira worklog</small>
              </div>
              <el-radio-group v-model="worklogMode" size="small" class="wl-mode-group">
                <el-radio-button value="by-day">Theo ngày</el-radio-button>
                <el-radio-button value="by-ticket">Theo ticket</el-radio-button>
              </el-radio-group>
            </div>

            <!-- Controls: date range + filters -->
            <div class="worklog-report-controls wl-controls-bar">
              <el-date-picker
                v-model="wlDateFrom"
                class="wl-control wl-date"
                type="date"
                placeholder="Từ ngày"
                format="DD/MM/YYYY"
                value-format="YYYY-MM-DD"
                size="small"
              />
              <el-date-picker
                v-model="wlDateTo"
                class="wl-control wl-date"
                type="date"
                placeholder="Đến ngày"
                format="DD/MM/YYYY"
                value-format="YYYY-MM-DD"
                size="small"
              />
              <!-- Lọc thành viên áp dụng cho cả hai báo cáo. -->
              <el-select
                v-model="wlAuthorFilter"
                class="wl-control wl-author-select"
                clearable
                placeholder="Tất cả thành viên"
                size="small"
              >
                <el-option v-for="a in wlKnownAuthors" :key="a" :label="a" :value="a" />
              </el-select>
              <!-- Filter ticket (chỉ hiện khi mode by-ticket) -->
              <el-select
                v-if="worklogMode === 'by-ticket'"
                v-model="wlTicketFilter"
                class="wl-control wl-ticket-select"
                clearable
                placeholder="Tất cả ticket"
                size="small"
              >
                <template #header>
                  <div class="wl-ticket-search">
                    <el-input
                      v-model="wlTicketSearch"
                      clearable
                      placeholder="Tìm ticket..."
                      size="small"
                      @keydown.stop
                    />
                  </div>
                </template>
                <el-option v-for="t in filteredWlTicketOptions" :key="t" :label="t" :value="t" />
              </el-select>
              <v-btn
                class="wl-action"
                size="small"
                color="primary"
                variant="flat"
                :loading="wlLoading"
                @click="loadActiveWorklog"
                >Xem báo cáo</v-btn
              >
              <v-btn
                v-if="worklogMode !== 'by-ticket'"
                class="wl-action"
                size="small"
                :disabled="!wlMemberReport"
                @click="exportWorklogCsv"
                >Export CSV</v-btn
              >
              <v-btn
                v-else
                class="wl-action"
                size="small"
                :disabled="!wlByTicketReport"
                @click="exportWorklogByTicketCsv"
                >Export CSV</v-btn
              >
            </div>

            <!-- Legend -->
            <div
              v-if="
                (worklogMode !== 'by-ticket' && wlMemberReport) || (worklogMode === 'by-ticket' && wlByTicketReport)
              "
              class="worklog-legend"
            >
              <span>Giờ log:</span>
              <span class="legend-dot" style="background: #1d4e38">0-1h</span>
              <span class="legend-dot" style="background: #37895e">1-2h</span>
              <span class="legend-dot" style="background: #2f7a56">2-4h</span>
              <span class="legend-dot" style="background: #276749">4-8h</span>
              <span class="legend-dot" style="background: #1a6b3c">≥8h</span>
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
              <el-empty
                v-else-if="wlMemberReport && !wlMemberReport.members.length"
                description="Không có dữ liệu logwork"
                :image-size="60"
              />
              <div v-else class="worklog-placeholder">
                <span>Chọn khoảng ngày và nhấn <b>Xem báo cáo</b>.</span>
              </div>
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
                      <tr v-for="ticket in wlTicketFilter ? [wlTicketFilter] : wlByTicketReport.tickets" :key="ticket">
                        <td class="ticket-key-cell">
                          <a class="jira-ticket-link" :href="jiraUrl(ticket)" target="_blank" rel="noreferrer">{{
                            ticket
                          }}</a>
                        </td>
                        <td
                          v-for="day in wlByTicketReport.days"
                          :key="day"
                          class="wl-cell"
                          :style="{
                            background: heatmapColor(
                              Object.values(wlByTicketReport.matrix[ticket] ?? {}).reduce(
                                (sum, authMap) => sum + (authMap[day] ?? 0),
                                0
                              )
                            ),
                          }"
                          :title="`${ticket} · ${formatDay(day)}: ${secondsToHours(
                            Object.values(wlByTicketReport.matrix[ticket] ?? {}).reduce(
                              (sum, authMap) => sum + (authMap[day] ?? 0),
                              0
                            )
                          )}h`"
                        >
                          <span v-if="Object.values(wlByTicketReport.matrix[ticket] ?? {}).some((m) => m[day])">
                            {{
                              secondsToHours(
                                Object.values(wlByTicketReport.matrix[ticket] ?? {}).reduce(
                                  (sum, m) => sum + (m[day] ?? 0),
                                  0
                                )
                              )
                            }}
                          </span>
                        </td>
                        <td class="total-cell">{{ secondsToHours(wlByTicketReport.ticketTotals[ticket] ?? 0) }}h</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <el-empty
                v-else-if="wlByTicketReport && !wlByTicketReport.tickets.length"
                description="Không có dữ liệu logwork"
                :image-size="60"
              />
              <div v-else class="worklog-placeholder">
                <span>Chọn khoảng ngày và nhấn <b>Xem báo cáo</b>.</span>
              </div>
            </template>
          </section>
        </el-tab-pane>

        <el-tab-pane name="settings">
          <template #label>
            <span class="jira-tab-label"
              ><i>⚙</i><span><b>Cấu hình</b></span></span
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
                  >{{ configurationChecks.filter((item) => item.ready).length }}/{{
                    configurationChecks.length
                  }}</strong
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
                <div>
                  <span>Backend environment</span
                  ><v-btn size="small" variant="text" @click="copyEnvTemplate">Copy</v-btn>
                </div>
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
                        settings.jiraType === 'cloud'
                          ? 'https://company.atlassian.net'
                          : 'https://jira.company.internal'
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
                <v-btn color="primary" variant="flat" prepend-icon="mdi-content-save-outline" @click="saveSettings"
                  >Lưu</v-btn
                >
                <v-btn :loading="testingConnection" prepend-icon="mdi-connection" @click="testConnection">
                  Test kết nối
                </v-btn></el-form
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
    </section>

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
              <span
                >Status<b
                  ><el-tag class="jira-status" :class="`jira-status--${statusTone(selectedIssue)}`">{{
                    selectedIssue.status
                  }}</el-tag></b
                ></span
              >
              <span
                >Assignee<b>{{ selectedIssue.assigneeName || 'Unassigned' }}</b></span
              >
              <span
                >Sprint<b>{{ selectedIssue.sprint || '—' }}</b></span
              >
              <span
                >Priority<b>{{ selectedIssue.priority || '—' }}</b></span
              >
              <span
                >Start date<b>{{ date(selectedIssue.startDate) }}</b></span
              >
              <span
                >Due date<b>{{ date(selectedIssue.dueDate) }}</b></span
              >
              <span class="detail-full"
                >Parent
                <b v-if="selectedIssue.parentKey">
                  <a
                    :href="`${settings.baseUrl}/browse/${selectedIssue.parentKey}`"
                    target="_blank"
                    rel="noreferrer"
                    class="parent-link"
                    >{{ selectedIssue.parentKey }}</a
                  >
                  <small>{{ selectedIssue.parentSummary }}</small>
                </b>
                <b v-else>—</b>
              </span>
              <span class="detail-full"
                >Labels
                <b v-if="parseLabels(selectedIssue.labels).length">
                  <span v-for="lbl in parseLabels(selectedIssue.labels)" :key="lbl" class="label-chip">{{ lbl }}</span>
                </b>
                <b v-else>—</b>
              </span>
              <span
                v-for="field in (settings.customFields || []).filter((field) => !isSprintField(field))"
                :key="field.id"
                >{{ field.label }}<b>{{ customFieldValue(selectedIssue, field) }}</b></span
              >
            </div>
            <p v-if="selectedIssue.description" class="description">{{ selectedIssue.description }}</p>
            <el-divider>Local metadata</el-divider>
            <el-form label-position="top">
              <el-form-item label="Internal category"><el-input v-model="metadata.internalCategory" /></el-form-item>
              <el-form-item label="Report note"
                ><el-input v-model="metadata.reportNote" type="textarea" :rows="4"
              /></el-form-item>
              <el-form-item label="Block reason"
                ><el-input v-model="metadata.blockReason" type="textarea" :rows="3"
              /></el-form-item>
              <div class="check-row">
                <el-checkbox v-model="metadata.highlight">Highlight</el-checkbox>
                <el-checkbox v-model="metadata.risk">Risk</el-checkbox>
              </div>
              <div class="drawer-actions">
                <v-btn :href="jiraUrl(selectedIssue)" target="_blank" append-icon="mdi-open-in-new">Open in Jira</v-btn>
                <v-btn color="primary" variant="flat" @click="saveMetadata">Save metadata</v-btn>
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
                  <div class="comment-meta">
                    <b>{{ c.authorName }}</b
                    ><span>{{ date(c.createdAtJira) }}</span>
                  </div>
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
  </div>
</template>

<style scoped>
.jira-workspace {
  --jira-blue: #579dff;
  --jira-surface: #0d1726;
  --jira-surface-raised: #0f1e33;
  --jira-surface-tint: #182840;
  --jira-border: #1b2f4a;
  --jira-border-strong: #294261;
  --jira-grid-border: #111c2c;
  --jira-control-bg: rgb(8 22 39 / 68%);
  --jira-text: #d8e3f1;
  --jira-text-muted: #9eacc0;
  --jira-ticket: #8bbdff;
  --jira-code-text: #a9ddba;
  --jira-tab-active-border: #376bb0;
  --jira-tab-active-bg: linear-gradient(135deg, #18365d, #182b49);
  --jira-tab-active-text: #fff;
}
.jira-shell {
  min-width: 0;
}
.jira-tabs {
  margin-top: 0;
}
.jira-tabs :deep(.el-tabs__header) {
  display: none;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--jira-surface);
  box-shadow: 0 10px 28px rgb(0 0 0 / 14%);
  position: sticky;
  top: 0;
  z-index: 5;
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
  color: var(--jira-text-muted);
}
.jira-tab-label {
  display: flex;
  min-width: 96px;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  transition: 160ms ease;
}
.jira-tab-label > i {
  display: grid;
  flex: 0 0 27px;
  height: 27px;
  place-items: center;
  border-radius: 8px;
  background: var(--jira-surface-tint);
  color: var(--jira-ticket);
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
  color: var(--jira-text);
  font-size: 11px;
  line-height: 1.2;
}
.jira-tab-label small {
  color: var(--jira-text-muted);
  font-size: 9px;
  line-height: 1.2;
}
.jira-tabs :deep(.el-tabs__item:hover) .jira-tab-label {
  border-color: var(--jira-border-strong);
  background: var(--jira-surface-raised);
}
.jira-tabs :deep(.el-tabs__item.is-active) .jira-tab-label {
  border-color: var(--jira-tab-active-border);
  background: var(--jira-tab-active-bg);
  box-shadow: inset 0 0 0 1px rgb(87 157 255 / 9%);
}
.jira-tabs :deep(.el-tabs__item.is-active) .jira-tab-label > i {
  background: #2463bd;
  color: white;
  box-shadow: 0 5px 14px rgb(36 99 189 / 30%);
}
.jira-tabs :deep(.el-tabs__item.is-active) .jira-tab-label b {
  color: var(--jira-tab-active-text);
}
.jira-setup {
  margin-bottom: 14px;
  padding: 18px;
  border: 1px solid var(--jira-border-strong);
  border-radius: 14px;
  background: var(--jira-tab-active-bg);
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
  color: var(--jira-ticket);
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
  border: 1px solid var(--jira-border);
  border-radius: 10px;
  background: var(--jira-surface);
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
  border: 1px solid var(--jira-border);
  border-radius: 11px;
  background: var(--jira-surface);
}
.env-example > div {
  height: 38px;
  padding: 0 12px;
  border-bottom: 1px solid var(--jira-border);
  color: var(--jira-text-muted);
  font-size: 10px;
  font-weight: 700;
}
.env-example pre {
  min-height: 72px;
  margin: 0;
  padding: 12px;
  color: var(--jira-code-text);
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
.dashboard-overview-grid,
.settings-grid {
  grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.65fr);
  margin-top: 14px;
}
.dashboard-grid--single {
  grid-template-columns: 1fr;
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
.status-overview-content {
  display: flex;
  align-items: center;
  gap: 24px;
  min-height: 152px;
}
.status-donut {
  display: grid;
  flex: 0 0 142px;
  width: 142px;
  height: 142px;
  place-items: center;
  border-radius: 50%;
  box-shadow: 0 10px 24px rgb(0 0 0 / 16%);
}
.status-donut > div {
  display: grid;
  width: 102px;
  height: 102px;
  place-content: center;
  border-radius: 50%;
  background: var(--panel);
  text-align: center;
}
.status-donut strong {
  color: var(--jira-text);
  font-size: 28px;
  line-height: 1;
}
.status-donut span {
  margin-top: 5px;
  color: var(--muted);
  font-size: 10px;
  font-weight: 700;
}
.status-chart-legend {
  display: grid;
  flex: 1;
  gap: 9px;
}
.status-chart-legend > div {
  display: grid;
  grid-template-columns: 9px 1fr auto;
  align-items: center;
  gap: 8px;
  color: var(--jira-text-muted);
  font-size: 11px;
}
.status-chart-legend > div > span {
  width: 9px;
  height: 9px;
  border-radius: 50%;
}
.status-chart-legend b {
  font-weight: 600;
}
.status-chart-legend strong {
  color: var(--jira-text);
  font-size: 13px;
}
.delivery-chart {
  display: grid;
  gap: 14px;
  padding-top: 5px;
}
.delivery-chart-row {
  display: grid;
  gap: 7px;
}
.delivery-chart-row > div:first-child {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: var(--jira-text-muted);
  font-size: 11px;
}
.delivery-chart-row b {
  color: var(--jira-text);
  font-size: 11px;
}
.delivery-chart-track {
  height: 10px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--jira-surface-tint);
}
.delivery-chart-track > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #3b82f6, #4ade80);
  box-shadow: 0 0 12px rgb(74 222 128 / 35%);
  transition: width 240ms ease;
}
.activity-row {
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
.activity-row span {
  display: grid;
  gap: 3px;
}
.activity-row span {
  font-size: 12px;
}
.issue-filters {
  display: grid;
  grid-template-columns: minmax(230px, 1.5fr) repeat(4, minmax(120px, 1fr));
  gap: 8px;
  margin-bottom: 14px;
}
.issues-card {
  display: flex;
  flex-direction: column;
  padding-bottom: 0;
}
.issues-table {
  border-top: 1px solid var(--line);
}
.issues-table :deep(.el-table__header-wrapper) {
  z-index: 1;
}
.issue-title {
  display: grid;
  gap: 4px;
}
.jira-ticket-link {
  color: var(--jira-ticket);
  font-size: 11px;
  font-weight: 700;
  text-decoration: none;
}
.jira-ticket-link:hover,
.jira-ticket-link:focus-visible {
  color: #b4d4ff;
  text-decoration: underline;
}
.jira-status {
  border: 0 !important;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
}
.jira-status--todo {
  --el-tag-bg-color: #ebecf0;
  --el-tag-border-color: #ebecf0;
  --el-tag-text-color: #44546f;
  background-color: #ebecf0 !important;
  border-color: #ebecf0 !important;
  color: #44546f !important;
}
.jira-status--in-progress {
  --el-tag-bg-color: #deebff;
  --el-tag-border-color: #deebff;
  --el-tag-text-color: #0052cc;
}
.jira-status--done {
  --el-tag-bg-color: #e3fcef;
  --el-tag-border-color: #e3fcef;
  --el-tag-text-color: #006644;
}
.jira-status--warning {
  --el-tag-bg-color: #fff0b3;
  --el-tag-border-color: #fff0b3;
  --el-tag-text-color: #7f5f01;
}
.jira-status--blocked {
  --el-tag-bg-color: #ffebe6;
  --el-tag-border-color: #ffebe6;
  --el-tag-text-color: #bf2600;
}
.issue-title span {
  font-weight: 650;
}
.board-filters {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
  margin-bottom: 12px;
}
.board-filters > * {
  max-width: 260px;
}
.due-filter-option {
  display: inline-flex;
  width: 100%;
  min-height: 26px;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 800;
  line-height: 1;
}
.due-filter-option small {
  margin-left: auto;
  color: inherit;
  font-size: 10px;
  font-weight: 700;
  opacity: .78;
}
.due-filter-option--on-track {
  background: #eaf8ef;
  color: #15803d;
}
.due-filter-option--due-soon {
  background: #fff4df;
  color: #d97706;
}
.due-filter-option--due-today {
  background: #ffead8;
  color: #ea580c;
}
.due-filter-option--overdue {
  background: #feecec;
  color: #dc2626;
}
.due-filter-option--overdue-severe {
  background: #ffe1e1;
  color: #c81e1e;
}
.due-filter-option--no-due {
  background: #f1f5f9;
  color: #64748b;
}
.board-warning-legend {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  gap: 7px;
  margin: -2px 0 12px;
}
.board-pane {
  display: flex;
  height: calc(100vh - 254px);
  min-height: 0;
  flex-direction: column;
}
.jira-board {
  display: grid;
  min-height: 0;
  flex: 1 1 auto;
  grid-template-columns: repeat(4, minmax(240px, 1fr));
  gap: 12px;
  align-items: start;
  overflow-x: auto;
  overflow-y: hidden;
}
.board-column {
  height: 100%;
  min-height: 0;
  padding: 0 12px 12px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.board-column header {
  display: flex;
  position: sticky;
  top: 0;
  z-index: 1;
  min-height: 58px;
  align-items: center;
  justify-content: space-between;
  margin: 0 -12px 18px;
  padding: 12px 16px;
  background: var(--panel);
  box-shadow: 0 8px 14px var(--panel);
}
.board-column-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}
.board-column-count {
  display: inline-flex;
  min-width: 26px;
  height: 26px;
  align-items: center;
  justify-content: center;
  padding: 0 8px;
  border-radius: 999px;
  background: #edf4ff;
  color: #5573a6;
  font-size: 12px;
  font-weight: 800;
}
.board-column-summary {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}
.board-column-summary-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 800;
  white-space: nowrap;
}
.board-column-summary-chip--overdue {
  background: #feecec;
  color: #dc2626;
}
.board-column-summary-chip--due-soon {
  background: #fff4df;
  color: #d97706;
}
.board-card {
  display: grid;
  position: relative;
  width: 100%;
  gap: 10px;
  margin-bottom: 9px;
  padding: 13px;
  border: 1px solid var(--jira-border);
  border-left-width: 4px;
  border-radius: 11px;
  background: var(--jira-surface);
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.board-card-alert-icon {
  display: grid;
  position: relative;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  place-items: center;
  border-radius: 50%;
  isolation: isolate;
}
.board-card-alert-icon :deep(.v-icon) {
  position: relative;
  z-index: 1;
  font-size: 16px;
}
.board-card-alert-icon.board-warning--on-track,
.board-card-alert-icon.board-warning--no-due {
  background: transparent;
  color: #94a3b8;
}
.board-card-alert-icon.board-warning--due-soon,
.board-card-alert-icon.board-warning--due-today {
  width: 32px;
  height: 32px;
  flex-basis: 32px;
  background: #fff4df;
}
.board-card-alert-icon.board-warning--due-soon {
  color: #f59e0b;
  animation: board-clock-soft-pulse 1.8s ease-in-out infinite;
}
.board-card-alert-icon.board-warning--due-today {
  color: #f59e0b;
  animation: board-clock-soft-pulse 1.8s ease-in-out infinite;
}
.board-clock-art {
  width: 18px;
  height: 18px;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
@keyframes board-clock-soft-pulse {
  0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgb(245 158 11 / 20%); }
  50% { transform: scale(1.07); box-shadow: 0 0 0 8px rgb(245 158 11 / 6%); }
}
.board-card-alert-icon.board-warning--overdue,
.board-card-alert-icon.board-warning--overdue-severe {
  background: transparent;
  box-shadow: none;
  overflow: visible;
}
.board-card-alert-icon.board-warning--overdue {
  width: 44px;
  height: 44px;
  flex-basis: 44px;
  margin-top: -3px;
  margin-right: -1px;
}
.board-card-alert-icon.board-warning--overdue-severe {
  width: 60px;
  height: 60px;
  flex-basis: 60px;
  margin-top: -13px;
  margin-right: -2px;
}
.board-fire-art {
  position: absolute;
  inset: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  isolation: isolate;
}
.board-fire-art:not(.board-fire-art--heavy)::before {
  content: '';
  position: absolute;
  z-index: 0;
  inset: 4px;
  border-radius: 50%;
  background: radial-gradient(
    circle at 50% 52%,
    rgb(255 252 252 / 99%) 0 24%,
    rgb(254 230 230 / 96%) 25% 58%,
    rgb(255 220 190 / 42%) 59% 80%,
    rgb(254 215 215 / 0%) 77%
  );
  filter: drop-shadow(0 4px 10px rgb(239 68 68 / 14%));
  animation: board-fire-halo 1.28s ease-in-out infinite;
}
.board-fire-art .board-fire-flame {
  position: relative;
  z-index: 2;
  width: 25px;
  height: 31px;
  overflow: visible;
  transform-origin: 50% 92%;
  filter: drop-shadow(0 2px 4px rgb(185 28 28 / 14%)) drop-shadow(0 6px 12px rgb(239 68 68 / 24%));
  animation: board-fire-flicker 820ms ease-in-out infinite;
}
.board-fire-art--heavy .board-fire-flame {
  width: 30px;
  height: 38px;
  margin-top: 5px;
  animation: board-fire-heavy-flicker 740ms ease-in-out infinite;
}
.board-fire-outline {
  position: absolute;
  z-index: 1;
  bottom: 0;
  left: 50%;
  width: 52px;
  height: 62px;
  overflow: visible;
  transform: translateX(-50%);
  transform-origin: 50% 100%;
  filter: drop-shadow(0 7px 14px rgb(251 113 133 / 16%)) drop-shadow(0 14px 26px rgb(239 68 68 / 20%));
  animation: board-fire-outline-breathe 1.06s ease-in-out infinite;
}
.board-fire-spark {
  position: absolute;
  z-index: 4;
  border-radius: 2px 70% 70% 70%;
  transform: rotate(45deg);
  opacity: .9;
}
.board-fire-spark--1 {
  top: -5px;
  right: 3px;
  width: 7px;
  height: 7px;
  background: #ffd54f;
  animation: board-fire-spark-1 1.05s ease-in-out infinite;
}
.board-fire-spark--2 {
  top: -14px;
  right: 16px;
  width: 5px;
  height: 5px;
  background: #ffca45;
  animation: board-fire-spark-2 880ms ease-in-out infinite;
}
.board-fire-spark--3 {
  top: -4px;
  left: 5px;
  width: 5px;
  height: 5px;
  background: #ffe082;
  animation: board-fire-spark-3 1.17s ease-in-out infinite;
}
.board-fire-spark--4 {
  top: -15px;
  left: 17px;
  width: 4px;
  height: 4px;
  background: #ffd24d;
  animation: board-fire-spark-4 950ms ease-in-out infinite;
}
.board-fire-spark--5 {
  top: 11px;
  right: 6px;
  width: 4px;
  height: 4px;
  background: #ffec99;
  animation: board-fire-spark-5 1.22s ease-in-out infinite;
}
@keyframes board-fire-halo {
  0%, 100% { transform: scale(1); filter: drop-shadow(0 4px 10px rgb(239 68 68 / 14%)); }
  50% { transform: scale(1.045); filter: drop-shadow(0 7px 14px rgb(239 68 68 / 18%)); }
}
@keyframes board-fire-outline-breathe {
  0%, 100% { transform: translateX(-50%) translateY(0) scaleX(1) scaleY(1); opacity: .96; }
  50% { transform: translateX(-50%) translateY(-1px) scaleX(1.025) scaleY(1.045); opacity: 1; }
}
@keyframes board-fire-flicker {
  0%, 100% { transform: translateY(0) scaleX(1) scaleY(1) rotate(0); }
  30% { transform: translateY(-1.5px) scaleX(.95) scaleY(1.08) rotate(-1.4deg); }
  63% { transform: translateY(-.6px) scaleX(1.03) scaleY(1.02) rotate(1.4deg); }
}
@keyframes board-fire-heavy-flicker {
  0%, 100% { transform: translateY(0) scaleX(1) scaleY(1) rotate(0); }
  28% { transform: translateY(-2.2px) scaleX(.94) scaleY(1.12) rotate(-1.6deg); }
  62% { transform: translateY(-.9px) scaleX(1.04) scaleY(1.04) rotate(1.6deg); }
}
@keyframes board-fire-spark-1 {
  0%, 100% { transform: translateY(4px) rotate(45deg) scale(.55); opacity: .08; }
  50% { transform: translateY(-7px) rotate(45deg) scale(1.08); opacity: .95; }
}
@keyframes board-fire-spark-2 {
  0%, 100% { transform: translateY(5px) rotate(45deg) scale(.5); opacity: .08; }
  50% { transform: translateY(-6px) rotate(45deg) scale(1.02); opacity: .86; }
}
@keyframes board-fire-spark-3 {
  0%, 100% { transform: translateY(3px) rotate(45deg) scale(.52); opacity: .08; }
  55% { transform: translateY(-5px) rotate(45deg) scale(.98); opacity: .76; }
}
@keyframes board-fire-spark-4 {
  0%, 100% { transform: translateY(4px) rotate(45deg) scale(.48); opacity: .06; }
  55% { transform: translateY(-6px) rotate(45deg) scale(.9); opacity: .65; }
}
@keyframes board-fire-spark-5 {
  0%, 100% { transform: translate(0, 2px) rotate(45deg) scale(.45); opacity: .06; }
  50% { transform: translate(5px, -4px) rotate(45deg) scale(.84); opacity: .58; }
}
.board-card:hover {
  border-color: var(--jira-tab-active-border);
  transform: translateY(-1px);
}
.board-card:focus-visible {
  outline: 2px solid var(--jira-ticket);
  outline-offset: 2px;
}
.board-card-head {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.board-card-head > .jira-ticket-link {
  color: var(--jira-ticket);
  font-size: 10px;
}
.board-card > strong {
  font-size: 12px;
  line-height: 1.45;
}
.board-card-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--muted);
  font-size: 10px;
}
.board-card-meta-chips {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.board-assignee {
  overflow: hidden;
  max-width: 125px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.board-card-due-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 800;
  line-height: 1;
}
.board-card-due-chip i {
  font-size: 12px;
  font-style: normal;
  line-height: 1;
}
.board-card-due-chip--on-track,
.board-card-due-chip--no-due {
  background: #f1f5f9;
  color: #475569;
}
.board-card-due-chip--due-soon,
.board-card-due-chip--due-today {
  background: #fff4df;
  color: #d97706;
}
.board-card-due-chip--overdue,
.board-card-due-chip--overdue-severe {
  background: #feecec;
  color: #dc2626;
}
.board-card-due-chip--complete {
  background: #eaf8ef;
  color: #15803d;
}
.board-warning {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  gap: 4px;
  padding: 4px 7px;
  border-radius: 6px;
  font-size: 10px;
  font-weight: 800;
  line-height: 1;
}
.board-warning i {
  font-style: normal;
}
.board-warning--complete {
  background: rgb(74 222 128 / 14%);
  color: #4ade80;
}
.board-warning--no-due {
  background: rgb(148 163 184 / 13%);
  color: #aebbd0;
}
.board-warning--on-track {
  background: rgb(74 222 128 / 12%);
  color: #67d391;
}
.board-warning--due-soon {
  background: rgb(251 191 36 / 14%);
  color: #f8c85c;
}
.board-warning--due-today {
  background: rgb(251 146 60 / 16%);
  color: #ff9a4d;
}
.board-warning--overdue {
  background: rgb(248 113 113 / 15%);
  color: #ff7f83;
}
.board-warning--overdue-severe {
  background: rgb(239 68 68 / 19%);
  color: #ff6868;
}
.board-card--on-track {
  border-left-color: #4ade80;
}
.board-card--no-due {
  border-left-color: #94a3b8;
}
.board-card--due-soon {
  border-left-color: #fbbf24;
}
.board-card--due-today {
  border-left-color: #fb923c;
}
.board-card--overdue {
  border-left-color: #f87171;
  box-shadow: 0 8px 24px rgb(15 23 42 / 5.5%), 0 0 0 1px rgb(239 68 68 / 3.8%), 0 0 18px rgb(239 68 68 / 8%);
}
.board-card--overdue-severe {
  border-color: #f05252;
  border-left-width: 4px;
  box-shadow: 0 8px 24px rgb(15 23 42 / 5.5%), 0 0 0 1px rgb(239 68 68 / 8%), 0 0 24px rgb(239 68 68 / 16%);
  animation: board-card-danger-pulse 1.65s ease-in-out infinite;
}
.board-card--overdue-severe:hover {
  box-shadow: 0 12px 30px rgb(15 23 42 / 8%), 0 0 0 1px rgb(239 68 68 / 12%), 0 0 30px rgb(239 68 68 / 22%);
}
@keyframes board-card-danger-pulse {
  0%, 100% { box-shadow: 0 8px 24px rgb(15 23 42 / 5.5%), 0 0 0 1px rgb(239 68 68 / 8%), 0 0 20px rgb(239 68 68 / 14%); }
  50% { box-shadow: 0 8px 24px rgb(15 23 42 / 6%), 0 0 0 2px rgb(239 68 68 / 18%), 0 0 30px rgb(239 68 68 / 28%); }
}
.board-card--complete {
  border-left-color: #4ade80;
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
  color: var(--jira-ticket);
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
  background: var(--jira-surface);
  color: var(--jira-text);
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
  .dashboard-overview-grid,
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
    grid-template-columns: repeat(4, 280px);
  }
}
@media (max-width: 960px) {
  .jira-tabs :deep(.el-tabs__header) {
    display: block;
    min-height: 0;
    margin: 0 0 16px;
    padding: 7px;
  }
}
@media (max-width: 700px) {
  .setup-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .jira-tabs :deep(.el-tabs__header) {
    display: block;
    min-height: 0;
    margin: 0 0 16px;
    padding: 7px;
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
  .status-overview-content {
    align-items: flex-start;
    flex-direction: column;
  }
}
@media (prefers-reduced-motion: reduce) {
  .board-card--due-soon,
  .board-card--due-today,
  .board-card--overdue,
  .board-card--overdue-severe,
  .board-card-alert-icon.board-warning--due-soon,
  .board-card-alert-icon.board-warning--due-today,
  .board-fire-art::before,
  .board-fire-flame,
  .board-fire-outline,
  .board-fire-spark {
    animation: none;
  }
}

/* ── New field styles ── */
.label-chip {
  display: inline-block;
  margin: 1px 3px 1px 0;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--jira-surface-tint);
  color: var(--jira-ticket);
  font-size: 10px;
  font-weight: 700;
}
.parent-chip {
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--jira-surface-tint);
  color: var(--jira-ticket);
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}
.parent-link {
  color: var(--jira-ticket);
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
  background: var(--jira-surface);
  border: 1px solid var(--jira-border);
}
.comment-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.comment-meta b {
  color: var(--jira-ticket);
  font-size: 11px;
}
.comment-meta span {
  color: var(--muted);
  font-size: 10px;
}
.comment-body {
  margin: 0;
  color: var(--jira-text);
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
  color: var(--jira-ticket);
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
  max-height: min(68vh, 680px);
  overflow: auto;
  overscroll-behavior: contain;
}
.worklog-matrix {
  min-width: 100%;
  padding: 2px;
}
.wl-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.wl-table th {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 6px 8px;
  background: var(--jira-surface);
  color: var(--jira-text-muted);
  font-weight: 700;
  text-align: center;
  white-space: nowrap;
  border: 1px solid var(--jira-border);
}
.member-col {
  text-align: left !important;
  min-width: 130px;
  position: sticky;
  left: 0;
  top: 0;
  z-index: 3;
}
.total-col {
  background: var(--jira-surface-raised) !important;
  color: var(--jira-ticket) !important;
  min-width: 64px;
}
.day-col {
  min-width: 52px;
}
.member-name {
  padding: 6px 10px;
  background: var(--jira-surface);
  color: var(--jira-text);
  font-weight: 700;
  white-space: nowrap;
  border: 1px solid var(--jira-border);
  position: sticky;
  left: 0;
  z-index: 2;
}
.wl-cell {
  width: 52px;
  height: 34px;
  text-align: center;
  border: 1px solid var(--jira-grid-border);
  cursor: default;
  color: #fff;
  text-shadow: 0 1px 2px rgb(0 0 0 / 36%);
  font-size: 10px;
  font-weight: 700;
}
.wl-cell:hover {
  outline: 2px solid #4c9eff;
  outline-offset: -2px;
  z-index: 2;
  position: relative;
}
.total-cell {
  padding: 6px 10px;
  background: var(--jira-surface-raised);
  color: var(--jira-ticket);
  font-weight: 700;
  text-align: center;
  border: 1px solid var(--jira-border);
  white-space: nowrap;
}
.worklog-placeholder {
  padding: 28px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
  border: 1px dashed var(--jira-border-strong);
  border-radius: 10px;
}
.worklog-placeholder b {
  color: var(--jira-ticket);
}
/* Worklog mode group */
.wl-mode-group {
  flex-shrink: 0;
}
.wl-mode-group :deep(.el-radio-button__inner) {
  min-width: 108px;
  border: 1px solid var(--jira-border-strong) !important;
  background: var(--jira-surface);
  color: var(--jira-text-muted);
  box-shadow: none !important;
  font-weight: 700;
}
.wl-mode-group :deep(.el-radio-button:first-child .el-radio-button__inner) {
  border-radius: 8px 0 0 8px !important;
}
.wl-mode-group :deep(.el-radio-button:last-child .el-radio-button__inner) {
  border-radius: 0 8px 8px 0 !important;
}
.wl-mode-group :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
  border-color: var(--jira-tab-active-border) !important;
  background: var(--jira-tab-active-bg);
  color: var(--jira-tab-active-text);
}
.wl-controls-bar {
  margin-bottom: 12px;
  align-items: center;
  flex-wrap: wrap;
  padding: 8px;
  border: 1px solid var(--jira-border-strong);
  border-radius: 10px;
  background: var(--jira-control-bg);
}
.wl-control {
  flex: 0 0 auto;
}
.wl-date {
  width: 142px;
}
.wl-author-select {
  width: 175px;
}
.wl-ticket-select {
  width: 190px;
}
.wl-ticket-search {
  padding: 7px;
  border-bottom: 1px solid var(--jira-border);
  background: var(--jira-surface);
}
.wl-ticket-search :deep(.el-input__wrapper) {
  min-height: 30px !important;
}
.wl-controls-bar :deep(.el-input__wrapper),
.wl-controls-bar :deep(.el-select__wrapper) {
  min-height: 32px !important;
  padding-block: 0 !important;
}
.wl-controls-bar :deep(.el-date-editor.el-input),
.wl-controls-bar :deep(.el-select) {
  height: 32px;
}
.wl-controls-bar :deep(.el-input__inner),
.wl-controls-bar :deep(.el-select__selected-item) {
  font-size: 11px;
  line-height: 32px;
}
.wl-controls-bar :deep(.v-btn.wl-action) {
  min-height: 32px !important;
  height: 32px;
  font-size: 11px !important;
}
@media (max-width: 680px) {
  .wl-control,
  .wl-date,
  .wl-author-select,
  .wl-ticket-select {
    width: 100%;
  }
  .wl-controls-bar :deep(.el-date-editor.el-input),
  .wl-controls-bar :deep(.el-select),
  .wl-controls-bar :deep(.v-btn.wl-action) {
    width: 100%;
  }
}
/* Ticket-based worklog table */
.wl-ticket-table .ticket-key-cell {
  padding: 8px 10px;
  background: var(--jira-surface);
  color: var(--jira-ticket);
  font-weight: 700;
  border: 1px solid var(--jira-border);
  vertical-align: middle;
  white-space: nowrap;
  text-align: left;
}
.wl-ticket-table .ticket-key-cell .jira-ticket-link {
  display: block;
  font-size: 12px;
  color: var(--jira-blue);
}
.ticket-total-badge {
  display: inline-block;
  margin-top: 3px;
  background: var(--jira-surface-raised);
  color: #72e59a;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 700;
}
.ticket-first-row td {
  border-top: 2px solid var(--jira-border-strong);
}
</style>
