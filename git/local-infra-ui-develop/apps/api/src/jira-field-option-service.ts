export type JiraFieldContextScope = {
  projectId?: string;
  issueTypeId?: string;
};

export type JiraFieldOptionClient = {
  baseUrl: string;
  authorization: string;
  requestTimeoutMs: number;
};

export type JiraOptionValue = {
  id: string;
  text: string;
};

type JiraFieldContext = JiraFieldContextScope & {
  id: string;
  projectIds: string[];
  issueTypeIds: string[];
};

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

type JiraFieldOptionServiceOptions = {
  ttlMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

const PAGE_SIZE = 100;
const MAX_PAGES = 1_000;

function cacheKey(...parts: string[]) {
  return parts.map((part) => encodeURIComponent(part)).join(':');
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function getOptionId(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = getOptionId(item);
      if (id) return id;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const node = value as Record<string, unknown>;
  for (const key of ['id', 'key']) {
    if (typeof node[key] === 'string' || typeof node[key] === 'number') return String(node[key]);
  }
  return null;
}

export function resolveOptionValue(value: unknown, options: Map<string, string>): JiraOptionValue | null {
  const id = getOptionId(value);
  if (!id) return null;
  const rawText =
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).value : undefined;
  return {
    id,
    text: options.get(id) ?? (typeof rawText === 'string' || typeof rawText === 'number' ? String(rawText) : id),
  };
}

export class JiraFieldOptionService {
  private readonly contextCache = new Map<string, CacheEntry<JiraFieldContext[]>>();
  private readonly contextRefreshes = new Map<string, Promise<JiraFieldContext[]>>();
  private readonly optionCache = new Map<string, CacheEntry<Map<string, string>>>();
  private readonly optionRefreshes = new Map<string, Promise<Map<string, string>>>();
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor({ ttlMs, fetchImpl = fetch, now = Date.now }: JiraFieldOptionServiceOptions) {
    this.ttlMs = ttlMs;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async getOptionMap(
    fieldId: string,
    client: JiraFieldOptionClient,
    scope: JiraFieldContextScope = {}
  ): Promise<Map<string, string>> {
    const context = await this.resolveContext(fieldId, client, scope);
    const key = cacheKey(client.baseUrl, fieldId, context.id);
    const cached = this.optionCache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    return this.refreshOptions(fieldId, context.id, client, key);
  }

  async refresh(fieldId: string, client: JiraFieldOptionClient, scope: JiraFieldContextScope = {}): Promise<void> {
    const context = await this.resolveContext(fieldId, client, scope);
    await this.refreshOptions(fieldId, context.id, client, cacheKey(client.baseUrl, fieldId, context.id), true);
  }

  private async resolveContext(
    fieldId: string,
    client: JiraFieldOptionClient,
    scope: JiraFieldContextScope
  ): Promise<JiraFieldContext> {
    const contexts = await this.getContexts(fieldId, client);
    const matches = contexts.filter(
      (context) =>
        (!context.projectIds.length || Boolean(scope.projectId && context.projectIds.includes(scope.projectId))) &&
        (!context.issueTypeIds.length || Boolean(scope.issueTypeId && context.issueTypeIds.includes(scope.issueTypeId)))
    );
    const ranked = matches
      .map((context) => ({
        context,
        score: (context.projectIds.length ? 2 : 0) + (context.issueTypeIds.length ? 1 : 0),
      }))
      .sort((first, second) => second.score - first.score);
    if (!ranked.length) {
      throw new Error(
        `Không tìm thấy Jira context phù hợp cho ${fieldId} (project=${scope.projectId ?? '-'}, issueType=${scope.issueTypeId ?? '-'})`
      );
    }
    if (ranked[1] && ranked[1].score === ranked[0].score) {
      throw new Error(
        `Có nhiều Jira context phù hợp cho ${fieldId} (project=${scope.projectId ?? '-'}, issueType=${scope.issueTypeId ?? '-'})`
      );
    }
    return ranked[0].context;
  }

  private async getContexts(fieldId: string, client: JiraFieldOptionClient) {
    const key = cacheKey(client.baseUrl, fieldId);
    const cached = this.contextCache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const activeRefresh = this.contextRefreshes.get(key);
    if (activeRefresh) return activeRefresh;
    const refresh = this.loadContexts(fieldId, client);
    this.contextRefreshes.set(key, refresh);
    try {
      const value = await refresh;
      this.contextCache.set(key, { expiresAt: this.now() + this.ttlMs, value });
      return value;
    } finally {
      this.contextRefreshes.delete(key);
    }
  }

  private async loadContexts(fieldId: string, client: JiraFieldOptionClient) {
    const values = await this.loadPages(
      `${client.baseUrl}/rest/api/3/field/${encodeURIComponent(fieldId)}/context`,
      client
    );
    return values
      .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'))
      .map((value) => ({
        id: String(value.id),
        projectIds: strings(value.projectIds),
        issueTypeIds: strings(value.issueTypeIds),
      }))
      .filter((context) => context.id && context.id !== 'undefined');
  }

  private async refreshOptions(
    fieldId: string,
    contextId: string,
    client: JiraFieldOptionClient,
    key: string,
    force = false
  ) {
    if (!force) {
      const cached = this.optionCache.get(key);
      if (cached && cached.expiresAt > this.now()) return cached.value;
    }
    const activeRefresh = this.optionRefreshes.get(key);
    if (activeRefresh) return activeRefresh;
    const refresh = this.loadOptions(fieldId, contextId, client);
    this.optionRefreshes.set(key, refresh);
    try {
      const value = await refresh;
      this.optionCache.set(key, { expiresAt: this.now() + this.ttlMs, value });
      return value;
    } finally {
      this.optionRefreshes.delete(key);
    }
  }

  private async loadOptions(fieldId: string, contextId: string, client: JiraFieldOptionClient) {
    const values = await this.loadPages(
      `${client.baseUrl}/rest/api/3/field/${encodeURIComponent(fieldId)}/context/${encodeURIComponent(contextId)}/option`,
      client
    );
    const options = new Map<string, string>();
    for (const value of values) {
      if (!value || typeof value !== 'object') continue;
      const option = value as Record<string, unknown>;
      if (
        (typeof option.id === 'string' || typeof option.id === 'number') &&
        (typeof option.value === 'string' || typeof option.value === 'number')
      ) {
        options.set(String(option.id), String(option.value));
      }
    }
    return options;
  }

  private async loadPages(url: string, client: JiraFieldOptionClient): Promise<unknown[]> {
    const values: unknown[] = [];
    let startAt = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const separator = url.includes('?') ? '&' : '?';
      const response = await this.fetchImpl(`${url}${separator}startAt=${startAt}&maxResults=${PAGE_SIZE}`, {
        headers: { accept: 'application/json', authorization: client.authorization },
        signal: AbortSignal.timeout(client.requestTimeoutMs),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`Jira trả về HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const pageValues = Array.isArray(payload.values) ? payload.values : [];
      values.push(...pageValues);
      const nextStart = startAt + pageValues.length;
      const total = Number(payload.total);
      if (
        payload.isLast === true ||
        !pageValues.length ||
        (Number.isFinite(total) && nextStart >= total) ||
        (payload.isLast === undefined && !Number.isFinite(total) && pageValues.length < PAGE_SIZE)
      ) {
        return values;
      }
      startAt = nextStart;
    }
    throw new Error(`Jira pagination vượt quá ${MAX_PAGES} trang cho ${url}`);
  }
}
