import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import type { AuditDatabase, JiraCommentInput, JiraIssueInput, JiraSettings, JiraWorklogInput } from './database.js';

const metadataBody = z.object({
  reportNote: z.string().max(10_000).default(''),
  internalCategory: z.string().trim().max(120).default(''),
  blockReason: z.string().max(5_000).default(''),
  highlight: z.boolean().default(false),
  risk: z.boolean().default(false),
});
const settingsBody = z.object({
  jiraType: z.enum(['cloud', 'data_center']),
  baseUrl: z
    .string()
    .url()
    .max(500)
    .transform((value) => value.replace(/\/+$/, '')),
  jql: z.string().trim().min(1).max(2_000),
  allowedProjects: z
    .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/))
    .min(1)
    .max(30),
  syncMode: z.enum(['manual', 'interval']),
  syncIntervalMinutes: z.number().int().min(15).max(1440),
  staleDays: z.number().int().min(1).max(365),
});

function plainText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const node = value as Record<string, unknown>;
  const own = typeof node.text === 'string' ? node.text : '';
  const children = Array.isArray(node.content) ? node.content.map(plainText).filter(Boolean).join('\n') : '';
  return (own || children || null) as string | null;
}

function sprintName(fields: Record<string, any>, config: Config) {
  const configuredSprint = config.JIRA_CUSTOM_FIELDS.find(
    (field) => field.role === 'sprint' || /^sprints?$/i.test(field.label.trim())
  );
  if (configuredSprint) {
    const sprint = displayCustomFieldValue(valueAtPath(fields[configuredSprint.id], configuredSprint.path));
    if (sprint) return sprint;
  }
  if (typeof fields.sprint?.name === 'string') return fields.sprint.name;
  for (const value of Object.values(fields)) {
    if (
      Array.isArray(value) &&
      value[0] &&
      typeof value[0] === 'object' &&
      typeof value[0].name === 'string' &&
      'state' in value[0]
    )
      return value[0].name;
  }
  return null;
}

function valueAtPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split('.').reduce<unknown>((current, key) => {
    if (Array.isArray(current) && /^\d+$/.test(key)) return current[Number(key)];
    if (current && typeof current === 'object') return (current as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

function displayCustomFieldValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const values = value.map(displayCustomFieldValue).filter((item): item is string => Boolean(item));
    return values.length ? values.join(', ') : null;
  }
  const node = value as Record<string, unknown>;
  for (const key of ['displayName', 'name', 'value', 'key']) {
    if (typeof node[key] === 'string' || typeof node[key] === 'number') return String(node[key]);
  }
  return plainText(node) ?? JSON.stringify(node);
}

function configuredCustomFields(fields: Record<string, any>, config: Config) {
  const values: Record<string, string> = {};
  console.debug('Configured Jira custom fields:', config.JIRA_CUSTOM_FIELDS);
  console.debug('fields:', fields);
  for (const field of config.JIRA_CUSTOM_FIELDS) {
    const value = displayCustomFieldValue(valueAtPath(fields[field.id], field.path));
    console.debug(`Custom field ${field.id} (${field.label}) value:`, value);
    if (value !== null) values[field.id] = value;
  }
  return Object.keys(values).length ? JSON.stringify(values) : null;
}

function mapIssue(issue: any, syncedAt: string, config: Config): JiraIssueInput {
  const fields = issue.fields ?? {};
  const labels = Array.isArray(fields.labels) && fields.labels.length ? JSON.stringify(fields.labels) : null;
  const parent = fields.parent ?? null;
  const mapped = {
    jiraId: String(issue.id ?? issue.key),
    jiraKey: String(issue.key),
    projectKey: String(fields.project?.key ?? String(issue.key).split('-')[0]),
    summary: String(fields.summary ?? ''),
    description: plainText(fields.description),
    issueType: fields.issuetype?.name ? String(fields.issuetype.name) : null,
    status: String(fields.status?.name ?? 'Unknown'),
    statusCategory: String(fields.status?.statusCategory?.key ?? 'new').toLowerCase(),
    statusColor: fields.status?.statusCategory?.colorName
      ? String(fields.status.statusCategory.colorName).toLowerCase()
      : null,
    assigneeName: fields.assignee?.displayName ? String(fields.assignee.displayName) : null,
    priority: fields.priority?.name ? String(fields.priority.name) : null,
    sprint: sprintName(fields, config),
    dueDate: fields.duedate ? String(fields.duedate) : null,
    parentKey: parent?.key ? String(parent.key) : null,
    parentSummary: parent?.fields?.summary ? String(parent.fields.summary) : null,
    labels,
    startDate: fields.startDate ?? fields.customfield_10015 ?? null,
    customFields: configuredCustomFields(fields, config),
    jiraUpdatedAt: String(fields.updated ?? syncedAt),
    syncedAt,
  };
  return { ...mapped, rawHash: createHash('sha256').update(JSON.stringify(mapped)).digest('hex') };
}

function jiraRequestContext(settings: JiraSettings, config: Config) {
  if (!config.JIRA_API_TOKEN)
    throw Object.assign(new Error('JIRA_API_TOKEN chưa được cấu hình ở backend'), {
      statusCode: 409,
      code: 'JIRA_SECRET_MISSING',
    });
  if (settings.jiraType === 'cloud' && !config.JIRA_EMAIL)
    throw Object.assign(new Error('JIRA_EMAIL là bắt buộc khi kết nối Jira Cloud'), {
      statusCode: 409,
      code: 'JIRA_EMAIL_MISSING',
    });

  return {
    apiVersion: settings.jiraType === 'cloud' ? '3' : '2',
    baseUrl: (config.JIRA_INTERNAL_URL || settings.baseUrl).replace(/\/+$/, ''),
    authorization:
      settings.jiraType === 'cloud'
        ? `Basic ${Buffer.from(`${config.JIRA_EMAIL}:${config.JIRA_API_TOKEN}`).toString('base64')}`
        : `Bearer ${config.JIRA_API_TOKEN}`,
  };
}

async function jiraRequestError(response: Response) {
  const detail = (await response.text()).slice(0, 500);
  return Object.assign(new Error(`Jira trả về HTTP ${response.status}${detail ? `: ${detail}` : ''}`), {
    statusCode: response.status === 401 || response.status === 403 ? 403 : 502,
    code: 'JIRA_REQUEST_FAILED',
  });
}

async function testJiraConnection(settings: JiraSettings, config: Config) {
  const { apiVersion, baseUrl, authorization } = jiraRequestContext(settings, config);
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/rest/api/${apiVersion}/myself`, {
    headers: { accept: 'application/json', authorization },
    signal: AbortSignal.timeout(config.JIRA_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw await jiraRequestError(response);
  const user: any = await response.json();
  return {
    connected: true,
    jiraType: settings.jiraType,
    baseUrl: settings.baseUrl,
    displayName: String(user.displayName ?? user.name ?? user.accountId ?? 'Jira user'),
    durationMs: Date.now() - startedAt,
  };
}

async function fetchJiraIssues(settings: JiraSettings, config: Config) {
  const { apiVersion, baseUrl, authorization } = jiraRequestContext(settings, config);
  const fields = [
    'summary',
    'description',
    'issuetype',
    'status',
    'assignee',
    'priority',
    'duedate',
    'updated',
    'project',
    'parent',
    'labels',
    'comment',
    ...config.JIRA_CUSTOM_FIELDS.map((field) => field.id),
  ];
  // Sprint and start_date are Jira Software custom fields whose IDs differ per site. Discover them.
  try {
    const fieldResponse = await fetch(`${baseUrl}/rest/api/${apiVersion}/field`, {
      headers: { accept: 'application/json', authorization },
      signal: AbortSignal.timeout(config.JIRA_REQUEST_TIMEOUT_MS),
    });
    if (fieldResponse.ok) {
      const fieldCatalog: any = await fieldResponse.json();
      if (Array.isArray(fieldCatalog)) {
        const sprintField = fieldCatalog.find((field) => String(field.name).toLowerCase() === 'sprint');
        if (sprintField?.id) fields.push(String(sprintField.id));
        const startField = fieldCatalog.find((field) =>
          ['start date', 'story start date', 'start_date'].includes(String(field.name).toLowerCase())
        );
        if (startField?.id && startField.id !== 'startDate') fields.push(String(startField.id));
      }
    }
  } catch {
    // Optional fields; permission failures must not block issue sync.
  }
  // Always include known cloud start date field
  if (!fields.includes('customfield_10015')) fields.push('customfield_10015');
  const all: any[] = [];
  let nextPageToken: string | undefined;
  let startAt = 0;
  let completed = false;
  for (let page = 0; page < 100; page += 1) {
    const cloud = settings.jiraType === 'cloud';
    const url = `${baseUrl}${cloud ? '/rest/api/3/search/jql' : '/rest/api/2/search'}`;
    const body = cloud
      ? { jql: settings.jql, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) }
      : { jql: settings.jql, fields, maxResults: 100, startAt };
    const response = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.JIRA_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw await jiraRequestError(response);
    const payload: any = await response.json();
    const issues = Array.isArray(payload.issues) ? payload.issues : [];
    all.push(...issues);
    if (cloud) {
      nextPageToken = payload.nextPageToken;
      if (payload.isLast === true || !nextPageToken) {
        completed = true;
        break;
      }
    } else {
      startAt += issues.length;
      if (!issues.length || startAt >= Number(payload.total ?? 0)) {
        completed = true;
        break;
      }
    }
  }
  if (!completed)
    throw Object.assign(new Error('JQL trả về quá 10.000 issue; hãy thu hẹp phạm vi trước khi sync'), {
      statusCode: 422,
      code: 'JIRA_RESULT_LIMIT',
    });
  const allowed = new Set(settings.allowedProjects);
  return all.filter((issue) => allowed.has(String(issue.fields?.project?.key ?? String(issue.key).split('-')[0])));
}

// Fetch worklogs for a list of issue keys. Runs at most CONCURRENCY requests simultaneously.
async function fetchJiraWorklogs(
  issueKeys: string[],
  settings: JiraSettings,
  config: Config,
  syncedAt: string
): Promise<JiraWorklogInput[]> {
  const { apiVersion, baseUrl, authorization } = jiraRequestContext(settings, config);
  const CONCURRENCY = 5;
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const results: JiraWorklogInput[] = [];

  async function fetchOne(key: string) {
    try {
      const response = await fetch(`${baseUrl}/rest/api/${apiVersion}/issue/${encodeURIComponent(key)}/worklog`, {
        headers: { accept: 'application/json', authorization },
        signal: AbortSignal.timeout(config.JIRA_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return;
      const payload: any = await response.json();
      const worklogs: any[] = Array.isArray(payload.worklogs) ? payload.worklogs : [];
      for (const w of worklogs) {
        if (!w.started || w.started < cutoff) continue;
        results.push({
          id: String(w.id),
          jiraKey: key,
          authorName: String(w.author?.displayName ?? w.author?.name ?? 'Unknown'),
          authorAccountId: w.author?.accountId ? String(w.author.accountId) : null,
          timeSpentSeconds: Number(w.timeSpentSeconds ?? 0),
          started: String(w.started),
          comment: w.comment ? (typeof w.comment === 'string' ? w.comment : plainText(w.comment)) : null,
          syncedAt,
        });
      }
    } catch {
      // worklog fetch failure is non-fatal
    }
  }

  // Run with bounded concurrency
  for (let i = 0; i < issueKeys.length; i += CONCURRENCY) {
    await Promise.all(issueKeys.slice(i, i + CONCURRENCY).map(fetchOne));
  }
  return results;
}

// Extract comments from issues fetched via search (comment field is included in issue fields)
function extractComments(issues: any[], syncedAt: string): JiraCommentInput[] {
  const results: JiraCommentInput[] = [];
  for (const issue of issues) {
    const comments: any[] = issue.fields?.comment?.comments ?? [];
    for (const c of comments) {
      results.push({
        id: String(c.id),
        jiraKey: String(issue.key),
        authorName: String(c.author?.displayName ?? c.author?.name ?? 'Unknown'),
        body: c.body ? (typeof c.body === 'string' ? c.body : plainText(c.body)) : null,
        createdAtJira: String(c.created),
        updatedAtJira: String(c.updated ?? c.created),
        syncedAt,
      });
    }
  }
  return results;
}

export function registerJiraRoutes(
  app: FastifyInstance,
  database: AuditDatabase,
  config: Config,
  actorFor: (request: FastifyRequest) => string
) {
  let syncInFlight = false;
  const performSync = async (actor: string) => {
    if (syncInFlight)
      throw Object.assign(new Error('Một lần sync Jira khác đang chạy'), {
        statusCode: 409,
        code: 'JIRA_SYNC_IN_PROGRESS',
      });
    syncInFlight = true;
    const id = `jira-sync-${randomUUID()}`;
    let runRecorded = false;
    try {
      await database.createJiraSyncRun(id, actor === 'scheduler' ? 'scheduled_jira' : 'jira', new Date().toISOString());
      runRecorded = true;
      const settings = await database.getJiraSettings();
      const sourceIssues = await fetchJiraIssues(settings, config);
      const syncedAt = new Date().toISOString();
      const result = await database.upsertJiraIssues(
        sourceIssues.map((issue) => mapIssue(issue, syncedAt, config)),
        settings.allowedProjects
      );
      // Sync comments (from embedded field in search results)
      const comments = extractComments(sourceIssues, syncedAt);
      await database.upsertJiraComments(comments);
      // Sync worklogs (requires per-issue API calls)
      const issueKeys = sourceIssues.map((issue) => String(issue.key));
      const worklogs = await fetchJiraWorklogs(issueKeys, settings, config, syncedAt);
      await database.upsertJiraWorklogs(worklogs);
      await database.finishJiraSyncRun(id, { status: 'succeeded', ...result });
      await database.addJiraAudit(actor, 'jira.sync', 'sync_run', id, null, {
        ...result,
        worklogs: worklogs.length,
        comments: comments.length,
      });
      return {
        id,
        ...result,
        total: sourceIssues.length,
        worklogs: worklogs.length,
        comments: comments.length,
        syncedAt,
      };
    } catch (cause: any) {
      if (runRecorded) {
        await database.finishJiraSyncRun(id, { status: 'failed', failed: 1, error: cause.message });
        await database.addJiraAudit(actor, 'jira.sync', 'sync_run', id, null, { error: cause.message }, 'failed');
      }
      throw cause;
    } finally {
      syncInFlight = false;
    }
  };

  app.get('/api/jira/dashboard', async () => {
    const settings = await database.getJiraSettings();
    return {
      ...(await database.jiraDashboard(settings.staleDays)),
      settings: {
        ...settings,
        hasToken: Boolean(config.JIRA_API_TOKEN),
        assigneeDisplayMap: config.JIRA_ASSIGNEE_DISPLAY_MAP,
      },
    };
  });

  app.get('/api/jira/issues', async (request) => {
    const query = z
      .object({
        q: z.string().max(160).optional(),
        status: z.string().max(100).optional(),
        assignee: z.string().max(255).optional(),
        priority: z.string().max(80).optional(),
        sprint: z.string().max(255).optional(),
        parentKey: z.string().max(80).optional(),
      })
      .parse(request.query);
    return { rows: await database.listJiraIssues(query) };
  });

  app.get('/api/jira/issues/:jiraKey', async (request) => {
    const { jiraKey } = z.object({ jiraKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/) }).parse(request.params);
    const issue = await database.getJiraIssue(jiraKey);
    if (!issue)
      throw Object.assign(new Error('Không tìm thấy Jira issue'), { statusCode: 404, code: 'JIRA_ISSUE_NOT_FOUND' });
    return issue;
  });

  app.get('/api/jira/issues/:jiraKey/comments', async (request) => {
    const { jiraKey } = z.object({ jiraKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/) }).parse(request.params);
    return { rows: await database.listJiraComments(jiraKey) };
  });

  app.get('/api/jira/issues/:jiraKey/worklogs', async (request) => {
    const { jiraKey } = z.object({ jiraKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/) }).parse(request.params);
    return { rows: await database.listJiraWorklogs({ jiraKey }) };
  });

  app.patch('/api/jira/issues/:jiraKey/metadata', async (request) => {
    const { jiraKey } = z.object({ jiraKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/) }).parse(request.params);
    const current = await database.getJiraIssue(jiraKey);
    if (!current)
      throw Object.assign(new Error('Không tìm thấy Jira issue'), { statusCode: 404, code: 'JIRA_ISSUE_NOT_FOUND' });
    const metadata = metadataBody.parse(request.body);
    const actor = actorFor(request);
    const saved = await database.saveJiraMetadata(jiraKey, metadata, actor);
    await database.addJiraAudit(actor, 'jira.metadata.update', 'jira_issue', jiraKey, current, metadata);
    return saved;
  });

  app.get('/api/jira/settings', async () => ({
    ...(await database.getJiraSettings()),
    hasToken: Boolean(config.JIRA_API_TOKEN),
    customFields: config.JIRA_CUSTOM_FIELDS,
    assigneeDisplayMap: config.JIRA_ASSIGNEE_DISPLAY_MAP,
  }));
  app.patch('/api/jira/settings', async (request) => {
    const before = await database.getJiraSettings();
    const body = settingsBody.parse(request.body);
    const saved = await database.saveJiraSettings({ ...body, updatedAt: new Date().toISOString() });
    await database.addJiraAudit(actorFor(request), 'jira.settings.update', 'integration', 'jira', before, saved);
    return {
      ...saved,
      hasToken: Boolean(config.JIRA_API_TOKEN),
      customFields: config.JIRA_CUSTOM_FIELDS,
      assigneeDisplayMap: config.JIRA_ASSIGNEE_DISPLAY_MAP,
    };
  });

  app.get('/api/jira/connection', async () => testJiraConnection(await database.getJiraSettings(), config));

  app.post('/api/jira/sync', async (request) => performSync(actorFor(request)));

  app.get('/api/jira/sync-runs', async () => ({ rows: await database.listJiraSyncRuns() }));
  app.get('/api/jira/audit', async () => ({ rows: await database.listJiraAudit() }));

  app.get('/api/jira/worklogs', async (request) => {
    const query = z
      .object({
        jiraKey: z.string().max(80).optional(),
        assignee: z.string().max(255).optional(),
        dateFrom: z.string().max(40).optional(),
        dateTo: z.string().max(40).optional(),
      })
      .parse(request.query);
    return { rows: await database.listJiraWorklogs(query) };
  });

  app.get('/api/jira/worklogs/report/by-ticket', async (request) => {
    const query = z
      .object({
        dateFrom: z
          .string()
          .max(40)
          .default(() => new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)),
        dateTo: z
          .string()
          .max(40)
          .default(() => new Date().toISOString().slice(0, 10)),
        authorName: z.string().max(255).optional(),
      })
      .parse(request.query);
    const rows = await database.worklogReportByTicket(query.dateFrom, query.dateTo, query.authorName);
    // Build unique author list and day list
    const authors = [...new Set((rows as any[]).map((r: any) => String(r.authorName)))].sort();
    const days = [...new Set((rows as any[]).map((r: any) => String(r.day)))].sort();
    const tickets = [...new Set((rows as any[]).map((r: any) => String(r.jiraKey)))].sort();
    // Build matrix: { [jiraKey]: { [authorName]: { [day]: totalSeconds } } }
    const matrix: Record<string, Record<string, Record<string, number>>> = {};
    const ticketTotals: Record<string, number> = {};
    for (const row of rows as any[]) {
      const key = String(row.jiraKey);
      const auth = String(row.authorName);
      const d = String(row.day);
      const secs = Number(row.totalSeconds);
      if (!matrix[key]) matrix[key] = {};
      if (!matrix[key][auth]) matrix[key][auth] = {};
      matrix[key][auth][d] = secs;
      ticketTotals[key] = (ticketTotals[key] ?? 0) + secs;
    }
    return { tickets, authors, days, matrix, ticketTotals, dateFrom: query.dateFrom, dateTo: query.dateTo };
  });

  app.get('/api/jira/worklogs/report', async (request) => {
    const query = z
      .object({
        dateFrom: z
          .string()
          .max(40)
          .default(() => new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)),
        dateTo: z
          .string()
          .max(40)
          .default(() => new Date().toISOString().slice(0, 10)),
        authorName: z.string().max(255).optional(),
      })
      .parse(request.query);
    const rows = await database.worklogReportByMemberByDay(query.dateFrom, query.dateTo, query.authorName);
    // Build member list and day list for matrix
    const members = [...new Set(rows.map((r: any) => String(r.authorName)))].sort();
    const days = [...new Set(rows.map((r: any) => String(r.day)))].sort();
    // Build lookup: { [member]: { [day]: totalSeconds } }
    const matrix: Record<string, Record<string, number>> = {};
    for (const row of rows as any[]) {
      const m = String(row.authorName);
      const d = String(row.day);
      if (!matrix[m]) matrix[m] = {};
      matrix[m][d] = Number(row.totalSeconds);
    }
    const totals: Record<string, number> = {};
    for (const member of members) {
      totals[member] = Object.values(matrix[member] ?? {}).reduce((a, b) => a + b, 0);
    }
    return { members, days, matrix, totals, dateFrom: query.dateFrom, dateTo: query.dateTo };
  });
  app.get('/api/jira/reports/weekly', async () => {
    const issues: any[] = await database.listJiraIssues();
    const groups = new Map<
      string,
      { name: string; total: number; done: number; inProgress: number; blocked: number }
    >();
    for (const issue of issues) {
      const name = issue.internalCategory || issue.issueType || 'Other';
      const group = groups.get(name) ?? { name, total: 0, done: 0, inProgress: 0, blocked: 0 };
      group.total += 1;
      if (issue.statusCategory === 'done') group.done += 1;
      if (String(issue.status).toLowerCase().includes('progress')) group.inProgress += 1;
      if (String(issue.status).toLowerCase().includes('block')) group.blocked += 1;
      groups.set(name, group);
    }
    const done = issues.filter((issue) => issue.statusCategory === 'done');
    const inProgress = issues.filter(
      (issue) => issue.statusCategory !== 'done' && String(issue.status).toLowerCase().includes('progress')
    );
    const blocked = issues.filter((issue) => String(issue.status).toLowerCase().includes('block'));
    const highlights = issues.filter(
      (issue) => Boolean(issue.highlight) || (issue.reportNote && issue.statusCategory === 'done')
    );
    const risks = issues.filter((issue) => Boolean(issue.risk) || issue.blockReason);
    const lines = [
      '# Weekly Jira report',
      '',
      `- Done: ${done.length}`,
      `- In progress: ${inProgress.length}`,
      `- Blocked: ${blocked.length}`,
      '',
      '## Highlights',
      ...highlights.map((issue) => `- **${issue.jiraKey}** ${issue.reportNote || issue.summary}`),
      '',
      '## Risks / blockers',
      ...risks.map((issue) => `- **${issue.jiraKey}** ${issue.blockReason || issue.reportNote || issue.summary}`),
    ];
    return { groups: [...groups.values()], done, inProgress, blocked, highlights, risks, markdown: lines.join('\n') };
  });

  const scheduler = setInterval(async () => {
    if (syncInFlight || !config.JIRA_API_TOKEN) return;
    try {
      const settings = await database.getJiraSettings();
      if (settings.syncMode !== 'interval') return;
      const [latest] = await database.listJiraSyncRuns(1);
      const lastStarted = latest ? new Date(String((latest as any).startedAt)).getTime() : 0;
      if (Date.now() - lastStarted >= settings.syncIntervalMinutes * 60_000) await performSync('scheduler');
    } catch (cause) {
      app.log.warn({ err: cause }, 'Scheduled Jira sync failed');
    }
  }, 60_000);
  scheduler.unref();
}
