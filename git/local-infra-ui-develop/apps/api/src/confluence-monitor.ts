import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import mysql, { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { Config } from './config.js';

type ActorFor = (request: FastifyRequest) => string;
type RuleRow = RowDataPacket & {
  id: string;
  spaceKey: string;
  spaceName: string;
  scopeType: 'ALL_PAGES' | 'SELECTED_PAGES';
  ignoreMinorEdit: number;
  enabled: number;
  createdAt: string;
  updatedAt: string;
};

type ConfluencePage = {
  id?: string | number;
  title?: string;
  space?: { key?: string; name?: string };
  version?: {
    number?: number;
    by?: { username?: string; userKey?: string; displayName?: string; fullName?: string };
    when?: string;
    message?: string;
    minorEdit?: boolean;
  };
  _links?: { base?: string; webui?: string };
};

const ruleBody = z
  .object({
    spaceKey: z.string().trim().min(1).max(255),
    spaceName: z.string().trim().min(1).max(255),
    scopeType: z.enum(['ALL_PAGES', 'SELECTED_PAGES']),
    pages: z
      .array(z.object({ id: z.string().trim().min(1).max(80), title: z.string().trim().min(1).max(500) }))
      .max(500),
    ignoreMinorEdit: z.boolean(),
    enabled: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.scopeType === 'SELECTED_PAGES' && value.pages.length === 0)
      context.addIssue({ code: 'custom', path: ['pages'], message: 'Hãy chọn ít nhất một trang' });
  });

const settingsBody = z
  .object({
    batchEnabled: z.boolean(),
    firstSyncTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    secondSyncTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    syncSpaceKeys: z.array(z.string().trim().min(1).max(255)).max(100),
  })
  .refine((value) => value.firstSyncTime !== value.secondSyncTime, {
    path: ['secondSyncTime'],
    message: 'Hai thời điểm batch sync phải khác nhau',
  });

const changesQuery = z.object({
  status: z.enum(['all', 'unread', 'read']).default('all'),
  spaceKey: z.string().max(255).optional(),
  pageId: z.string().max(80).optional(),
  changedBy: z.string().max(255).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

function secureEqual(actual: string, expected: string) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function asBoolean(value: unknown) {
  return Boolean(Number(value));
}

function pageActor(page: ConfluencePage) {
  const by = page.version?.by;
  return {
    key: String(by?.userKey ?? by?.username ?? 'unknown'),
    name: String(by?.displayName ?? by?.fullName ?? by?.username ?? 'Unknown user'),
  };
}

function dayStartIso() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

export class ConfluenceMonitor {
  private readonly pool: Pool;
  private readonly baseUrl: string;
  private readonly publicBaseUrl: string;
  private spaceCache: { expiresAt: number; rows: Array<{ key: string; name: string }> } | undefined;
  private scheduler: NodeJS.Timeout | undefined;
  private syncPromise: Promise<unknown> | undefined;

  constructor(private readonly config: Config) {
    this.pool = mysql.createPool({
      host: config.MYSQL_HOST,
      port: config.MYSQL_PORT,
      user: config.MYSQL_USER,
      password: config.MYSQL_PASSWORD,
      database: config.MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 5,
      charset: 'utf8mb4',
    });
    this.baseUrl = (config.CONFLUENCE_INTERNAL_URL || config.CONFLUENCE_BASE_URL).replace(/\/+$/, '');
    this.publicBaseUrl = config.CONFLUENCE_BASE_URL.replace(/\/+$/, '');
  }

  async initialize() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS confluence_connections (
        id TINYINT PRIMARY KEY, name VARCHAR(160) NOT NULL, base_url VARCHAR(500) NOT NULL,
        webhook_id VARCHAR(100), webhook_status VARCHAR(30) NOT NULL DEFAULT 'inactive',
        last_webhook_at VARCHAR(40), last_connection_at VARCHAR(40), last_error TEXT,
        enabled TINYINT(1) NOT NULL DEFAULT 1
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS confluence_monitor_rules (
        id VARCHAR(80) PRIMARY KEY, connection_id TINYINT NOT NULL DEFAULT 1,
        space_key VARCHAR(255) NOT NULL, space_name VARCHAR(255) NOT NULL,
        scope_type VARCHAR(30) NOT NULL, ignore_minor_edit TINYINT(1) NOT NULL DEFAULT 1,
        enabled TINYINT(1) NOT NULL DEFAULT 1, created_by VARCHAR(255) NOT NULL,
        created_at VARCHAR(40) NOT NULL, updated_at VARCHAR(40) NOT NULL,
        KEY confluence_rules_space_enabled (space_key, enabled)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS confluence_monitor_rule_pages (
        id VARCHAR(80) PRIMARY KEY, rule_id VARCHAR(80) NOT NULL, page_id VARCHAR(80) NOT NULL,
        page_title VARCHAR(500) NOT NULL, UNIQUE KEY confluence_rule_page (rule_id, page_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS confluence_change_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY, connection_id TINYINT NOT NULL DEFAULT 1,
        page_id VARCHAR(80) NOT NULL, page_title VARCHAR(500) NOT NULL,
        space_key VARCHAR(255) NOT NULL, space_name VARCHAR(255) NOT NULL,
        previous_version INT NOT NULL, current_version INT NOT NULL,
        changed_by_key VARCHAR(255) NOT NULL, changed_by_name VARCHAR(255) NOT NULL,
        changed_at VARCHAR(40) NOT NULL, version_message TEXT, minor_edit TINYINT(1) NOT NULL DEFAULT 0,
        confluence_url VARCHAR(1000) NOT NULL, created_at VARCHAR(40) NOT NULL,
        UNIQUE KEY confluence_change_version (connection_id, page_id, current_version),
        KEY confluence_change_changed_at (changed_at), KEY confluence_change_space (space_key),
        KEY confluence_change_actor (changed_by_key), KEY confluence_change_page (page_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS confluence_change_read_states (
        id BIGINT AUTO_INCREMENT PRIMARY KEY, change_event_id BIGINT NOT NULL, user_id VARCHAR(255) NOT NULL,
        read_at VARCHAR(40) NOT NULL, UNIQUE KEY confluence_change_user (change_event_id, user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS confluence_page_states (
        connection_id TINYINT NOT NULL DEFAULT 1, page_id VARCHAR(80) NOT NULL,
        space_key VARCHAR(255) NOT NULL, current_version INT NOT NULL, checked_at VARCHAR(40) NOT NULL,
        PRIMARY KEY (connection_id, page_id), KEY confluence_state_space (space_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS confluence_pages (
        connection_id TINYINT NOT NULL DEFAULT 1, page_id VARCHAR(80) NOT NULL,
        page_title VARCHAR(500) NOT NULL, space_key VARCHAR(255) NOT NULL, space_name VARCHAR(255) NOT NULL,
        current_version INT NOT NULL, changed_by_key VARCHAR(255) NOT NULL, changed_by_name VARCHAR(255) NOT NULL,
        changed_at VARCHAR(40) NOT NULL, version_message TEXT, minor_edit TINYINT(1) NOT NULL DEFAULT 0,
        confluence_url VARCHAR(1000) NOT NULL, synced_at VARCHAR(40) NOT NULL,
        PRIMARY KEY (connection_id, page_id), KEY confluence_pages_space (space_key),
        KEY confluence_pages_title (page_title(191))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS confluence_pending_changes (
        id BIGINT AUTO_INCREMENT PRIMARY KEY, connection_id TINYINT NOT NULL DEFAULT 1,
        page_id VARCHAR(80) NOT NULL, page_title VARCHAR(500) NOT NULL,
        space_key VARCHAR(255) NOT NULL, space_name VARCHAR(255) NOT NULL,
        previous_version INT NOT NULL, current_version INT NOT NULL,
        changed_by_key VARCHAR(255) NOT NULL, changed_by_name VARCHAR(255) NOT NULL,
        changed_at VARCHAR(40) NOT NULL, version_message TEXT, minor_edit TINYINT(1) NOT NULL DEFAULT 0,
        confluence_url VARCHAR(1000) NOT NULL, created_at VARCHAR(40) NOT NULL,
        UNIQUE KEY confluence_pending_version (connection_id, page_id, current_version),
        KEY confluence_pending_changed_at (changed_at), KEY confluence_pending_space (space_key),
        KEY confluence_pending_actor (changed_by_key), KEY confluence_pending_page (page_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS confluence_monitor_settings (
        id TINYINT PRIMARY KEY, batch_enabled TINYINT(1) NOT NULL DEFAULT 1,
        first_sync_time VARCHAR(5) NOT NULL, second_sync_time VARCHAR(5) NOT NULL,
        sync_space_keys TEXT NOT NULL, last_sync_at VARCHAR(40), last_batch_slot VARCHAR(80),
        updated_at VARCHAR(40) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS confluence_sync_runs (
        id VARCHAR(80) PRIMARY KEY, source VARCHAR(100) NOT NULL, space_keys TEXT NOT NULL,
        started_at VARCHAR(40) NOT NULL, finished_at VARCHAR(40), status VARCHAR(30) NOT NULL,
        scanned_count INT NOT NULL DEFAULT 0, change_count INT NOT NULL DEFAULT 0,
        error_summary TEXT, KEY confluence_sync_started (started_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ];
    for (const statement of statements) await this.pool.query(statement);
    const now = new Date().toISOString();
    await this.pool.execute(
      `INSERT IGNORE INTO confluence_connections (id, name, base_url, webhook_status, enabled)
       VALUES (1, 'Confluence Data Center', ?, 'inactive', 1)`,
      [this.publicBaseUrl]
    );
    await this.pool.execute(
      `INSERT IGNORE INTO confluence_monitor_settings
       (id, batch_enabled, first_sync_time, second_sync_time, sync_space_keys, updated_at)
       VALUES (1, 1, '09:00', '17:00', '[]', ?)`,
      [now]
    );
    if (this.config.CONFLUENCE_DEMO_MODE) await this.seedDemoData();
    else await this.removeDemoData();
  }

  private demoTimestamp(position: number) {
    const now = Date.now();
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return new Date(start.getTime() + ((now - start.getTime()) * position) / 13).toISOString();
  }

  private async seedDemoRule(
    connection: PoolConnection,
    id: string,
    spaceKey: string,
    spaceName: string,
    scopeType: 'ALL_PAGES' | 'SELECTED_PAGES',
    ignoreMinorEdit: boolean,
    enabled: boolean,
    now: string
  ) {
    await connection.execute(
      `INSERT IGNORE INTO confluence_monitor_rules
       (id, space_key, space_name, scope_type, ignore_minor_edit, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'demo-seed', ?, ?)`,
      [id, spaceKey, spaceName, scopeType, ignoreMinorEdit ? 1 : 0, enabled ? 1 : 0, now, now]
    );
  }

  private async seedDemoRulePage(
    connection: PoolConnection,
    id: string,
    ruleId: string,
    pageId: string,
    pageTitle: string
  ) {
    await connection.execute(
      `INSERT IGNORE INTO confluence_monitor_rule_pages (id, rule_id, page_id, page_title)
       VALUES (?, ?, ?, ?)`,
      [id, ruleId, pageId, pageTitle]
    );
  }

  private async seedDemoChange(
    connection: PoolConnection,
    pageId: string,
    pageTitle: string,
    spaceKey: string,
    spaceName: string,
    previousVersion: number,
    currentVersion: number,
    changedByKey: string,
    changedByName: string,
    position: number,
    minorEdit = false
  ) {
    const changedAt = this.demoTimestamp(position);
    const confluenceUrl = `https://confluence.demo/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`;
    await connection.execute(
      `INSERT IGNORE INTO confluence_pages
       (connection_id, page_id, page_title, space_key, space_name, current_version,
        changed_by_key, changed_by_name, changed_at, version_message, minor_edit, confluence_url, synced_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pageId,
        pageTitle,
        spaceKey,
        spaceName,
        previousVersion,
        changedByKey,
        changedByName,
        changedAt,
        currentVersion % 2 ? 'Cập nhật nội dung và hướng dẫn sử dụng' : 'Bổ sung thông tin triển khai',
        minorEdit ? 1 : 0,
        confluenceUrl,
        changedAt,
      ]
    );
    await connection.execute(
      `INSERT IGNORE INTO confluence_pending_changes
       (connection_id, page_id, page_title, space_key, space_name, previous_version, current_version,
        changed_by_key, changed_by_name, changed_at, version_message, minor_edit, confluence_url, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pageId,
        pageTitle,
        spaceKey,
        spaceName,
        previousVersion,
        currentVersion,
        changedByKey,
        changedByName,
        changedAt,
        currentVersion % 2 ? 'Cập nhật nội dung và hướng dẫn sử dụng' : 'Bổ sung thông tin triển khai',
        minorEdit ? 1 : 0,
        confluenceUrl,
        changedAt,
      ]
    );
  }

  private async seedDemoData() {
    const connection = await this.pool.getConnection();
    const now = new Date().toISOString();
    try {
      await connection.beginTransaction();
      await this.seedDemoRule(
        connection,
        '00000000-0000-4000-8000-000000000001',
        'IT',
        'IT Support',
        'ALL_PAGES',
        true,
        true,
        now
      );
      await this.seedDemoRule(
        connection,
        '00000000-0000-4000-8000-000000000002',
        'KNOW',
        'Knowledge Base',
        'SELECTED_PAGES',
        false,
        true,
        now
      );
      await this.seedDemoRule(
        connection,
        '00000000-0000-4000-8000-000000000003',
        'PROD',
        'Product',
        'ALL_PAGES',
        true,
        true,
        now
      );
      await this.seedDemoRule(
        connection,
        '00000000-0000-4000-8000-000000000004',
        'HR',
        'Human Resources',
        'ALL_PAGES',
        true,
        false,
        now
      );
      await this.seedDemoRulePage(
        connection,
        'demo-rule-page-knowledge-config',
        '00000000-0000-4000-8000-000000000002',
        'demo-1003',
        'Knowledge Base – Cài đặt hệ thống'
      );
      await this.seedDemoRulePage(
        connection,
        'demo-rule-page-knowledge-faq',
        '00000000-0000-4000-8000-000000000002',
        'demo-1004',
        'FAQ – Hệ thống'
      );
      await this.seedDemoChange(
        connection,
        'demo-1001',
        'API Authentication – Hướng dẫn tích hợp',
        'IT',
        'IT Support',
        17,
        18,
        'u-nguyen-a',
        'Nguyễn Văn A',
        1
      );
      await this.seedDemoChange(
        connection,
        'demo-1002',
        'HDSD – Quy trình xử lý lỗi',
        'IT',
        'IT Support',
        14,
        15,
        'u-tran-b',
        'Trần Thị B',
        2
      );
      await this.seedDemoChange(
        connection,
        'demo-1003',
        'Knowledge Base – Cài đặt hệ thống',
        'KNOW',
        'Knowledge Base',
        6,
        7,
        'u-le-c',
        'Lê Văn C',
        3
      );
      await this.seedDemoChange(
        connection,
        'demo-1004',
        'FAQ – Hệ thống',
        'KNOW',
        'Knowledge Base',
        3,
        4,
        'u-pham-d',
        'Phạm Thị D',
        4,
        true
      );
      await this.seedDemoChange(
        connection,
        'demo-1005',
        'Product Roadmap',
        'PROD',
        'Product',
        9,
        10,
        'u-hoang-e',
        'Hoàng Văn E',
        5
      );
      await this.seedDemoChange(
        connection,
        'demo-1006',
        'HR – Chính sách nghỉ phép',
        'HR',
        'Human Resources',
        5,
        6,
        'u-nguyen-a',
        'Nguyễn Văn A',
        6
      );
      await this.seedDemoChange(
        connection,
        'demo-1001',
        'API Authentication – Hướng dẫn tích hợp',
        'IT',
        'IT Support',
        18,
        19,
        'u-nguyen-a',
        'Nguyễn Văn A',
        7
      );
      await this.seedDemoChange(
        connection,
        'demo-1002',
        'HDSD – Quy trình xử lý lỗi',
        'IT',
        'IT Support',
        15,
        16,
        'u-tran-b',
        'Trần Thị B',
        8
      );
      await this.seedDemoChange(
        connection,
        'demo-1003',
        'Knowledge Base – Cài đặt hệ thống',
        'KNOW',
        'Knowledge Base',
        7,
        8,
        'u-le-c',
        'Lê Văn C',
        9
      );
      await this.seedDemoChange(
        connection,
        'demo-1004',
        'FAQ – Hệ thống',
        'KNOW',
        'Knowledge Base',
        4,
        5,
        'u-pham-d',
        'Phạm Thị D',
        10
      );
      await this.seedDemoChange(
        connection,
        'demo-1005',
        'Product Roadmap',
        'PROD',
        'Product',
        10,
        11,
        'u-hoang-e',
        'Hoàng Văn E',
        11
      );
      await this.seedDemoChange(
        connection,
        'demo-1006',
        'HR – Chính sách nghỉ phép',
        'HR',
        'Human Resources',
        6,
        7,
        'u-nguyen-a',
        'Nguyễn Văn A',
        12
      );
      await connection.execute(
        `UPDATE confluence_connections SET name = 'Confluence Demo (MySQL)', base_url = 'https://confluence.demo',
         webhook_id = 'demo-webhook', webhook_status = 'active', last_webhook_at = ?,
         last_connection_at = ?, last_error = NULL WHERE id = 1`,
        [now, now]
      );
      await connection.execute(
        `UPDATE confluence_monitor_settings SET sync_space_keys = ?, last_sync_at = ?
         WHERE id = 1 AND sync_space_keys = '[]'`,
        [JSON.stringify(['IT', 'KNOW', 'PROD']), now]
      );
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }

  private async removeDemoData() {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `DELETE read_state FROM confluence_change_read_states read_state
         INNER JOIN confluence_change_events event ON event.id = read_state.change_event_id
         WHERE event.page_id LIKE 'demo-%'`
      );
      await connection.execute("DELETE FROM confluence_change_events WHERE page_id LIKE 'demo-%'");
      await connection.execute("DELETE FROM confluence_page_states WHERE page_id LIKE 'demo-%'");
      await connection.execute("DELETE FROM confluence_pending_changes WHERE page_id LIKE 'demo-%'");
      await connection.execute("DELETE FROM confluence_pages WHERE page_id LIKE 'demo-%'");
      await connection.execute(
        `DELETE page FROM confluence_monitor_rule_pages page
         INNER JOIN confluence_monitor_rules rule ON rule.id = page.rule_id
         WHERE rule.created_by = 'demo-seed'`
      );
      await connection.execute("DELETE FROM confluence_monitor_rules WHERE created_by = 'demo-seed'");
      await connection.execute("DELETE FROM confluence_sync_runs WHERE source LIKE 'demo:%'");
      await connection.execute(
        `UPDATE confluence_connections SET name = 'Confluence Data Center', base_url = ?,
         webhook_id = NULL, webhook_status = 'inactive', last_webhook_at = NULL,
         last_connection_at = NULL WHERE id = 1 AND name = 'Confluence Demo (MySQL)'`,
        [this.publicBaseUrl]
      );
      await connection.execute(
        `UPDATE confluence_monitor_settings SET sync_space_keys = '[]'
         WHERE id = 1 AND sync_space_keys = ?`,
        [JSON.stringify(['IT', 'KNOW', 'PROD'])]
      );
      await connection.commit();
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }

  private async request<T>(path: string, init: RequestInit = {}) {
    if (!this.config.CONFLUENCE_API_TOKEN)
      throw Object.assign(new Error('CONFLUENCE_API_TOKEN chưa được cấu hình ở backend'), {
        statusCode: 409,
        code: 'CONFLUENCE_SECRET_MISSING',
      });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.CONFLUENCE_REQUEST_TIMEOUT_MS);
    try {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${this.config.CONFLUENCE_API_TOKEN}`);
      headers.set('accept', 'application/json');
      if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
      const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok)
        throw Object.assign(new Error(String(body.message ?? `Confluence trả về HTTP ${response.status}`)), {
          statusCode: response.status >= 500 ? 502 : response.status,
          code: 'CONFLUENCE_REQUEST_FAILED',
        });
      await this.pool.execute(
        'UPDATE confluence_connections SET last_connection_at = ?, last_error = NULL WHERE id = 1',
        [new Date().toISOString()]
      );
      return body as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async connectionStatus() {
    const [rows] = await this.pool.query<Array<RowDataPacket & Record<string, unknown>>>(
      `SELECT name, base_url AS baseUrl, webhook_id AS webhookId, webhook_status AS webhookStatus,
       last_webhook_at AS lastWebhookAt, last_connection_at AS lastConnectionAt, last_error AS lastError
       FROM confluence_connections WHERE id = 1`
    );
    return {
      ...rows[0],
      configured: this.config.CONFLUENCE_DEMO_MODE || Boolean(this.config.CONFLUENCE_API_TOKEN),
      demoMode: this.config.CONFLUENCE_DEMO_MODE,
    };
  }

  async testConnection() {
    if (this.config.CONFLUENCE_DEMO_MODE) {
      const rows = await this.spaces();
      return { connected: true, demoMode: true, checkedAt: new Date().toISOString(), reachableSpaces: rows.length };
    }
    const data = await this.request<{ results?: unknown[] }>('/rest/api/space?limit=1');
    return { connected: true, checkedAt: new Date().toISOString(), reachableSpaces: data.results?.length ?? 0 };
  }

  async registerWebhook() {
    if (this.config.CONFLUENCE_DEMO_MODE) {
      const now = new Date().toISOString();
      await this.pool.execute(
        `UPDATE confluence_connections SET webhook_id = 'demo-webhook', webhook_status = 'active',
         last_webhook_at = ?, last_error = NULL WHERE id = 1`,
        [now]
      );
      return { webhookId: 'demo-webhook', status: 'active', demoMode: true };
    }
    if (!this.config.CONFLUENCE_WEBHOOK_SECRET || !this.config.CONFLUENCE_APP_URL)
      throw Object.assign(new Error('Cần cấu hình CONFLUENCE_WEBHOOK_SECRET và CONFLUENCE_APP_URL'), {
        statusCode: 409,
        code: 'CONFLUENCE_WEBHOOK_CONFIG_MISSING',
      });
    const body = await this.request<Record<string, unknown>>('/rest/api/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Confluence Monitor',
        events: ['page_created', 'page_updated', 'page_removed'],
        configuration: { secret: this.config.CONFLUENCE_WEBHOOK_SECRET },
        url: `${this.config.CONFLUENCE_APP_URL.replace(/\/+$/, '')}/api/confluence/webhook`,
        active: true,
      }),
    });
    const webhookId = String(body.id ?? body.self ?? 'registered');
    await this.pool.execute(
      "UPDATE confluence_connections SET webhook_id = ?, webhook_status = 'active', last_error = NULL WHERE id = 1",
      [webhookId]
    );
    return { webhookId, status: 'active' };
  }

  async spaces(force = false) {
    if (this.config.CONFLUENCE_DEMO_MODE) {
      const [rows] = await this.pool.query<Array<RowDataPacket & { key: string; name: string }>>(
        `SELECT space_key AS \`key\`, space_name AS name FROM confluence_monitor_rules
         UNION SELECT space_key AS \`key\`, space_name AS name FROM confluence_pages
         ORDER BY name`
      );
      return rows;
    }
    if (!force && this.spaceCache && this.spaceCache.expiresAt > Date.now()) return this.spaceCache.rows;
    const rows: Array<{ key: string; name: string }> = [];
    let start = 0;
    do {
      const data = await this.request<{ results?: Array<{ key?: string; name?: string }>; size?: number }>(
        `/rest/api/space?limit=100&start=${start}`
      );
      const batch = (data.results ?? [])
        .filter((space) => space.key)
        .map((space) => ({ key: String(space.key), name: String(space.name ?? space.key) }));
      rows.push(...batch);
      if (batch.length < 100) break;
      start += batch.length;
    } while (start < 10_000);
    rows.sort((a, b) => a.name.localeCompare(b.name));
    this.spaceCache = { expiresAt: Date.now() + 5 * 60_000, rows };
    return rows;
  }

  async pages(spaceKey: string, query = '', start = 0, requestedLimit = 1000) {
    const limit = Math.min(Math.max(requestedLimit, 1), 1000);
    if (this.config.CONFLUENCE_DEMO_MODE) {
      const search = `%${query.trim()}%`;
      const [rows] = await this.pool.execute<Array<RowDataPacket & { id: string; title: string }>>(
        `SELECT page_id AS id, page_title AS title FROM confluence_pages
         WHERE space_key = ? AND page_title LIKE ?
         UNION SELECT page.page_id AS id, page.page_title AS title
         FROM confluence_monitor_rule_pages page
         INNER JOIN confluence_monitor_rules rule ON rule.id = page.rule_id
         WHERE rule.space_key = ? AND page.page_title LIKE ?
         ORDER BY title LIMIT ? OFFSET ?`,
        [spaceKey, search, spaceKey, search, limit + 1, start]
      );
      return {
        rows: rows.slice(0, limit),
        nextStart: start + Math.min(rows.length, limit),
        hasMore: rows.length > limit,
      };
    }
    const rows: Array<{ id: string; title: string }> = [];
    let cursor = start;
    while (rows.length < limit) {
      const batchSize = Math.min(100, limit - rows.length);
      const params = new URLSearchParams({ type: 'page', spaceKey, limit: String(batchSize), start: String(cursor) });
      let data: { results?: ConfluencePage[]; _links?: { next?: string } };
      if (query.trim()) {
        const escapedSpace = spaceKey.replace(/[\"\\]/g, '');
        const escapedQuery = query.trim().replace(/[\"\\]/g, '');
        const searchParams = new URLSearchParams({
          cql: `type=page AND space=\"${escapedSpace}\" AND title ~ \"${escapedQuery}\"`,
          limit: String(batchSize),
          start: String(cursor),
        });
        data = await this.request(`/rest/api/content/search?${searchParams}`);
      } else {
        data = await this.request(`/rest/api/content?${params}`);
      }
      const batch = (data.results ?? []).map((page) => ({ id: String(page.id), title: String(page.title ?? page.id) }));
      rows.push(...batch);
      cursor += batch.length;
      if (!data._links?.next && batch.length < batchSize) return { rows, nextStart: cursor, hasMore: false };
      if (batch.length === 0) return { rows, nextStart: cursor, hasMore: false };
    }
    return { rows, nextStart: cursor, hasMore: true };
  }

  private async rawRules(enabledOnly = false) {
    const [rules] = await this.pool.query<RuleRow[]>(
      `SELECT id, space_key AS spaceKey, space_name AS spaceName, scope_type AS scopeType,
       ignore_minor_edit AS ignoreMinorEdit, enabled, created_at AS createdAt, updated_at AS updatedAt
       FROM confluence_monitor_rules ${enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY space_name, created_at`
    );
    const [pages] = await this.pool.query<Array<RowDataPacket & { ruleId: string; id: string; title: string }>>(
      'SELECT rule_id AS ruleId, page_id AS id, page_title AS title FROM confluence_monitor_rule_pages ORDER BY page_title'
    );
    return rules.map((rule) => ({
      ...rule,
      ignoreMinorEdit: asBoolean(rule.ignoreMinorEdit),
      enabled: asBoolean(rule.enabled),
      pages: pages.filter((page) => page.ruleId === rule.id).map(({ id, title }) => ({ id, title })),
    }));
  }

  async rules() {
    return this.rawRules();
  }

  async saveRule(id: string | undefined, input: z.infer<typeof ruleBody>, actor: string) {
    const value = ruleBody.parse(input);
    const ruleId = id ?? randomUUID();
    const now = new Date().toISOString();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      if (id) {
        const [result] = await connection.execute<mysql.ResultSetHeader>(
          `UPDATE confluence_monitor_rules SET space_key = ?, space_name = ?, scope_type = ?,
           ignore_minor_edit = ?, enabled = ?, updated_at = ? WHERE id = ?`,
          [
            value.spaceKey,
            value.spaceName,
            value.scopeType,
            value.ignoreMinorEdit ? 1 : 0,
            value.enabled ? 1 : 0,
            now,
            id,
          ]
        );
        if (!result.affectedRows) throw Object.assign(new Error('Không tìm thấy rule'), { statusCode: 404 });
      } else {
        await connection.execute(
          `INSERT INTO confluence_monitor_rules
           (id, space_key, space_name, scope_type, ignore_minor_edit, enabled, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ruleId,
            value.spaceKey,
            value.spaceName,
            value.scopeType,
            value.ignoreMinorEdit ? 1 : 0,
            value.enabled ? 1 : 0,
            actor,
            now,
            now,
          ]
        );
      }
      await connection.execute('DELETE FROM confluence_monitor_rule_pages WHERE rule_id = ?', [ruleId]);
      if (value.scopeType === 'SELECTED_PAGES')
        for (const page of value.pages)
          await connection.execute(
            'INSERT INTO confluence_monitor_rule_pages (id, rule_id, page_id, page_title) VALUES (?, ?, ?, ?)',
            [randomUUID(), ruleId, page.id, page.title]
          );
      await connection.commit();
      return (await this.rawRules()).find((rule) => rule.id === ruleId);
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }

  async deleteRule(id: string) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('DELETE FROM confluence_monitor_rule_pages WHERE rule_id = ?', [id]);
      const [result] = await connection.execute<mysql.ResultSetHeader>(
        'DELETE FROM confluence_monitor_rules WHERE id = ?',
        [id]
      );
      await connection.commit();
      return result.affectedRows > 0;
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }

  async settings(): Promise<{
    batchEnabled: boolean;
    firstSyncTime: string;
    secondSyncTime: string;
    syncSpaceKeys: string[];
    lastSyncAt: string | null;
    updatedAt: string;
    timezone: string;
  }> {
    const [rows] = await this.pool.query<Array<RowDataPacket & Record<string, unknown>>>(
      `SELECT batch_enabled AS batchEnabled, first_sync_time AS firstSyncTime,
       second_sync_time AS secondSyncTime, sync_space_keys AS syncSpaceKeys,
       last_sync_at AS lastSyncAt, updated_at AS updatedAt FROM confluence_monitor_settings WHERE id = 1`
    );
    const row = rows[0] ?? {};
    return {
      batchEnabled: asBoolean(row.batchEnabled),
      firstSyncTime: String(row.firstSyncTime ?? '09:00'),
      secondSyncTime: String(row.secondSyncTime ?? '17:00'),
      syncSpaceKeys: JSON.parse(String(row.syncSpaceKeys ?? '[]')) as string[],
      lastSyncAt: row.lastSyncAt ? String(row.lastSyncAt) : null,
      updatedAt: String(row.updatedAt ?? ''),
      timezone: this.config.CONFLUENCE_SYNC_TIMEZONE,
    };
  }

  async saveSettings(input: z.infer<typeof settingsBody>) {
    const value = settingsBody.parse(input);
    const now = new Date().toISOString();
    await this.pool.execute(
      `UPDATE confluence_monitor_settings SET batch_enabled = ?, first_sync_time = ?, second_sync_time = ?,
       sync_space_keys = ?, updated_at = ? WHERE id = 1`,
      [value.batchEnabled ? 1 : 0, value.firstSyncTime, value.secondSyncTime, JSON.stringify(value.syncSpaceKeys), now]
    );
    return this.settings();
  }

  private matchesRule(rule: Awaited<ReturnType<ConfluenceMonitor['rawRules']>>[number], pageId: string) {
    return rule.scopeType === 'ALL_PAGES' || rule.pages.some((page) => page.id === pageId);
  }

  private async currentState(pageId: string) {
    const [rows] = await this.pool.execute<Array<RowDataPacket & { currentVersion: number }>>(
      'SELECT current_version AS currentVersion FROM confluence_pages WHERE connection_id = 1 AND page_id = ?',
      [pageId]
    );
    return rows[0]?.currentVersion;
  }

  private pageValues(page: ConfluencePage) {
    const actor = pageActor(page);
    const base = String(page._links?.base ?? this.publicBaseUrl).replace(/\/+$/, '');
    const webui = String(page._links?.webui ?? '');
    return {
      pageId: String(page.id ?? ''),
      pageTitle: String(page.title ?? page.id ?? ''),
      spaceKey: String(page.space?.key ?? ''),
      spaceName: String(page.space?.name ?? page.space?.key ?? ''),
      currentVersion: Number(page.version?.number ?? 0),
      changedByKey: actor.key,
      changedByName: actor.name,
      changedAt: String(page.version?.when ?? new Date().toISOString()),
      versionMessage: String(page.version?.message ?? ''),
      minorEdit: Boolean(page.version?.minorEdit),
      confluenceUrl: webui.startsWith('http') ? webui : `${base}${webui}`,
    };
  }

  private async saveApprovedPage(page: ConfluencePage) {
    const value = this.pageValues(page);
    const syncedAt = new Date().toISOString();
    await this.pool.execute(
      `INSERT INTO confluence_pages
       (connection_id, page_id, page_title, space_key, space_name, current_version,
        changed_by_key, changed_by_name, changed_at, version_message, minor_edit, confluence_url, synced_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE page_title = VALUES(page_title), space_key = VALUES(space_key),
       space_name = VALUES(space_name), current_version = VALUES(current_version),
       changed_by_key = VALUES(changed_by_key), changed_by_name = VALUES(changed_by_name),
       changed_at = VALUES(changed_at), version_message = VALUES(version_message),
       minor_edit = VALUES(minor_edit), confluence_url = VALUES(confluence_url), synced_at = VALUES(synced_at)`,
      [
        value.pageId,
        value.pageTitle,
        value.spaceKey,
        value.spaceName,
        value.currentVersion,
        value.changedByKey,
        value.changedByName,
        value.changedAt,
        value.versionMessage,
        value.minorEdit ? 1 : 0,
        value.confluenceUrl,
        syncedAt,
      ]
    );
  }

  private async savePage(
    page: ConfluencePage,
    createChange: boolean,
    rules: Awaited<ReturnType<ConfluenceMonitor['rawRules']>>
  ) {
    const pageId = String(page.id ?? '');
    const spaceKey = String(page.space?.key ?? '');
    const matching = rules.filter((rule) => rule.spaceKey === spaceKey && this.matchesRule(rule, pageId));
    if (!pageId || !spaceKey || matching.length === 0) return false;
    const currentVersion = Number(page.version?.number ?? 0);
    if (!Number.isInteger(currentVersion) || currentVersion < 1) return false;
    const previousState = await this.currentState(pageId);
    if (!createChange || previousState === undefined) {
      await this.saveApprovedPage(page);
      return false;
    }
    if (currentVersion <= previousState) return false;
    const minorEdit = Boolean(page.version?.minorEdit);
    if (minorEdit && matching.every((rule) => rule.ignoreMinorEdit)) {
      const [pending] = await this.pool.execute<Array<RowDataPacket & { count: number }>>(
        'SELECT COUNT(*) AS count FROM confluence_pending_changes WHERE connection_id = 1 AND page_id = ?',
        [pageId]
      );
      if (!Number(pending[0]?.count)) await this.saveApprovedPage(page);
      return false;
    }
    return this.insertPendingChange(page, previousState);
  }

  private async insertPendingChange(page: ConfluencePage, previousVersion: number) {
    const value = this.pageValues(page);
    const [result] = await this.pool.execute<mysql.ResultSetHeader>(
      `INSERT IGNORE INTO confluence_pending_changes
       (connection_id, page_id, page_title, space_key, space_name, previous_version, current_version,
        changed_by_key, changed_by_name, changed_at, version_message, minor_edit, confluence_url, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        value.pageId,
        value.pageTitle,
        value.spaceKey,
        value.spaceName,
        previousVersion,
        value.currentVersion,
        value.changedByKey,
        value.changedByName,
        value.changedAt,
        value.versionMessage,
        value.minorEdit ? 1 : 0,
        value.confluenceUrl,
        new Date().toISOString(),
      ]
    );
    return result.affectedRows > 0;
  }

  private async contentPage(pageId: string) {
    return this.request<ConfluencePage>(`/rest/api/content/${encodeURIComponent(pageId)}?expand=space,version`);
  }

  async processWebhook(request: FastifyRequest) {
    const payload = (request.body ?? {}) as Record<string, any>;
    const expected = this.config.CONFLUENCE_WEBHOOK_SECRET;
    if (expected) {
      const header = request.headers['x-confluence-webhook-secret'] ?? request.headers['x-atlassian-webhook-secret'];
      const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
      const actual = String(
        Array.isArray(header) ? header[0] : (header ?? bearer ?? payload.configuration?.secret ?? payload.secret ?? '')
      );
      if (!secureEqual(actual, expected))
        throw Object.assign(new Error('Webhook secret không hợp lệ'), {
          statusCode: 401,
          code: 'INVALID_WEBHOOK_SECRET',
        });
    }
    const event = String(payload.event ?? payload.webhookEvent ?? payload.type ?? '');
    if (event && !event.includes('page_updated') && event !== 'page_updated')
      return { accepted: true, ignored: 'event' };
    const candidate = (payload.page ?? payload.content ?? {}) as ConfluencePage;
    const pageId = String(candidate.id ?? payload.pageId ?? '');
    if (!pageId)
      throw Object.assign(new Error('Webhook không có page ID'), { statusCode: 400, code: 'PAGE_ID_MISSING' });
    const rules = await this.rawRules(true);
    const candidateSpace = String(candidate.space?.key ?? payload.spaceKey ?? '');
    const possible = rules.some(
      (rule) => (!candidateSpace || rule.spaceKey === candidateSpace) && this.matchesRule(rule, pageId)
    );
    if (!possible) return { accepted: true, ignored: 'rule' };
    const page = await this.contentPage(pageId);
    const matching = rules.filter((rule) => rule.spaceKey === page.space?.key && this.matchesRule(rule, pageId));
    if (!matching.length) return { accepted: true, ignored: 'rule' };
    const created = await this.savePage(page, true, rules);
    await this.pool.execute(
      "UPDATE confluence_connections SET webhook_status = 'active', last_webhook_at = ?, last_error = NULL WHERE id = 1",
      [new Date().toISOString()]
    );
    return { accepted: true, created };
  }

  private async scanSpace(spaceKey: string, rules: Awaited<ReturnType<ConfluenceMonitor['rawRules']>>) {
    const spaceRules = rules.filter((rule) => rule.spaceKey === spaceKey);
    let start = 0;
    let scanned = 0;
    let changed = 0;
    if (spaceRules.every((rule) => rule.scopeType === 'SELECTED_PAGES')) {
      const pageIds = [...new Set(spaceRules.flatMap((rule) => rule.pages.map((page) => page.id)))];
      for (const pageId of pageIds) {
        const page = await this.contentPage(pageId);
        scanned += 1;
        if (await this.savePage(page, true, rules)) changed += 1;
      }
      return { scanned, changed };
    }
    do {
      const params = new URLSearchParams({
        type: 'page',
        spaceKey,
        expand: 'space,version',
        limit: '100',
        start: String(start),
      });
      const data = await this.request<{ results?: ConfluencePage[] }>(`/rest/api/content?${params}`);
      const pages = data.results ?? [];
      for (const page of pages) {
        scanned += 1;
        if (await this.savePage(page, true, rules)) changed += 1;
      }
      if (pages.length < 100) break;
      start += pages.length;
    } while (start < 100_000);
    return { scanned, changed };
  }

  private async runDemoSync(source: string, requestedSpaceKeys?: string[]) {
    const settings = await this.settings();
    const rules = await this.rawRules(true);
    const allowed = new Set(rules.map((rule) => rule.spaceKey));
    const configuredSpaceKeys = requestedSpaceKeys?.length ? requestedSpaceKeys : settings.syncSpaceKeys;
    const selected = configuredSpaceKeys.filter((key) => allowed.has(key));
    const spaceKeys = [...new Set(configuredSpaceKeys.length ? selected : [...allowed])];
    if (!spaceKeys.length)
      throw Object.assign(new Error('Chưa có Space nào được bật theo dõi'), {
        statusCode: 409,
        code: 'NO_MONITORED_SPACE',
      });
    const [rows] = await this.pool.query<
      Array<
        RowDataPacket & {
          pageId: string;
          pageTitle: string;
          spaceKey: string;
          spaceName: string;
          currentVersion: number;
          confluenceUrl: string;
        }
      >
    >(
      `SELECT page.page_id AS pageId, page.page_title AS pageTitle, page.space_key AS spaceKey,
       page.space_name AS spaceName,
       GREATEST(page.current_version, COALESCE((SELECT MAX(pending.current_version)
        FROM confluence_pending_changes pending
        WHERE pending.connection_id = page.connection_id AND pending.page_id = page.page_id), 0)) AS currentVersion,
       page.confluence_url AS confluenceUrl
       FROM confluence_pages page ORDER BY page.synced_at, page.page_id`
    );
    const target = rows.find((row) => spaceKeys.includes(row.spaceKey));
    if (!target)
      throw Object.assign(new Error('Không có page demo phù hợp với Space đã chọn'), {
        statusCode: 409,
        code: 'NO_DEMO_PAGE',
      });
    const currentVersion = Number(target.currentVersion) + 1;
    const people = [
      ['u-nguyen-a', 'Nguyễn Văn A'],
      ['u-tran-b', 'Trần Thị B'],
      ['u-le-c', 'Lê Văn C'],
      ['u-pham-d', 'Phạm Thị D'],
      ['u-hoang-e', 'Hoàng Văn E'],
    ];
    const person = people[currentVersion % people.length];
    const now = new Date().toISOString();
    const created = await this.insertPendingChange(
      {
        id: target.pageId,
        title: target.pageTitle,
        space: { key: target.spaceKey, name: target.spaceName },
        version: {
          number: currentVersion,
          by: { userKey: person[0], displayName: person[1] },
          when: now,
          message: 'Thay đổi được tạo bởi phiên sync demo',
          minorEdit: false,
        },
        _links: { webui: target.confluenceUrl },
      },
      target.currentVersion
    );
    const id = randomUUID();
    await this.pool.execute(
      `INSERT INTO confluence_sync_runs
       (id, source, space_keys, started_at, finished_at, status, scanned_count, change_count)
       VALUES (?, ?, ?, ?, ?, 'succeeded', 1, ?)`,
      [id, `demo:${source}`, JSON.stringify(spaceKeys), now, now, created ? 1 : 0]
    );
    await this.pool.execute('UPDATE confluence_monitor_settings SET last_sync_at = ? WHERE id = 1', [now]);
    return {
      id,
      status: 'succeeded',
      source,
      spaceKeys,
      scanned: 1,
      changed: created ? 1 : 0,
      startedAt: now,
      finishedAt: now,
      demoMode: true,
    };
  }

  async sync(source: string, requestedSpaceKeys?: string[]) {
    if (this.syncPromise)
      throw Object.assign(new Error('Một phiên sync Confluence đang chạy'), {
        statusCode: 409,
        code: 'SYNC_IN_PROGRESS',
      });
    const run = async () => {
      if (this.config.CONFLUENCE_DEMO_MODE) return this.runDemoSync(source, requestedSpaceKeys);
      const settings = await this.settings();
      const rules = await this.rawRules(true);
      const allowed = new Set(rules.map((rule) => rule.spaceKey));
      const configuredSpaceKeys = requestedSpaceKeys?.length ? requestedSpaceKeys : settings.syncSpaceKeys;
      const selected = configuredSpaceKeys.filter((key) => allowed.has(key));
      const spaceKeys = [...new Set(configuredSpaceKeys.length ? selected : [...allowed])];
      if (!spaceKeys.length)
        throw Object.assign(new Error('Chưa có Space nào được bật theo dõi'), {
          statusCode: 409,
          code: 'NO_MONITORED_SPACE',
        });
      const id = randomUUID();
      const startedAt = new Date().toISOString();
      await this.pool.execute(
        `INSERT INTO confluence_sync_runs (id, source, space_keys, started_at, status) VALUES (?, ?, ?, ?, 'running')`,
        [id, source, JSON.stringify(spaceKeys), startedAt]
      );
      let scanned = 0;
      let changed = 0;
      try {
        for (const spaceKey of spaceKeys) {
          const result = await this.scanSpace(spaceKey, rules);
          scanned += result.scanned;
          changed += result.changed;
        }
        const finishedAt = new Date().toISOString();
        await this.pool.execute(
          `UPDATE confluence_sync_runs SET finished_at = ?, status = 'succeeded', scanned_count = ?, change_count = ? WHERE id = ?`,
          [finishedAt, scanned, changed, id]
        );
        await this.pool.execute('UPDATE confluence_monitor_settings SET last_sync_at = ? WHERE id = 1', [finishedAt]);
        return { id, status: 'succeeded', source, spaceKeys, scanned, changed, startedAt, finishedAt };
      } catch (cause) {
        await this.pool.execute(
          `UPDATE confluence_sync_runs SET finished_at = ?, status = 'failed', scanned_count = ?, change_count = ?, error_summary = ? WHERE id = ?`,
          [new Date().toISOString(), scanned, changed, cause instanceof Error ? cause.message : String(cause), id]
        );
        throw cause;
      }
    };
    this.syncPromise = run();
    try {
      return await this.syncPromise;
    } finally {
      this.syncPromise = undefined;
    }
  }

  async changes(actor: string, input: unknown) {
    const query = changesQuery.parse(input);
    const where: string[] = [];
    const values: unknown[] = [];
    if (query.status === 'read') where.push('1 = 0');
    if (query.spaceKey) {
      where.push('event.space_key = ?');
      values.push(query.spaceKey);
    }
    if (query.pageId) {
      where.push('event.page_id = ?');
      values.push(query.pageId);
    }
    if (query.changedBy) {
      where.push('event.changed_by_key = ?');
      values.push(query.changedBy);
    }
    if (query.from) {
      where.push('event.changed_at >= ?');
      values.push(`${query.from}T00:00:00.000Z`);
    }
    if (query.to) {
      where.push('event.changed_at <= ?');
      values.push(`${query.to}T23:59:59.999Z`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [countRows] = await this.pool.query<Array<RowDataPacket & { total: number }>>(
      `SELECT COUNT(*) AS total FROM confluence_pending_changes event ${clause}`,
      values
    );
    const [rows] = await this.pool.query<Array<RowDataPacket & Record<string, unknown>>>(
      `SELECT event.id, event.page_id AS pageId, event.page_title AS pageTitle,
       event.space_key AS spaceKey, event.space_name AS spaceName,
       event.previous_version AS previousVersion, event.current_version AS currentVersion,
       event.changed_by_key AS changedByKey, event.changed_by_name AS changedByName,
       event.changed_at AS changedAt, event.version_message AS versionMessage,
       event.minor_edit AS minorEdit, event.confluence_url AS confluenceUrl,
       0 AS isRead
       FROM confluence_pending_changes event
       ${clause} ORDER BY event.changed_at DESC LIMIT ? OFFSET ?`,
      [...values, query.limit, (query.page - 1) * query.limit]
    );
    return {
      rows: rows.map((row) => ({ ...row, minorEdit: asBoolean(row.minorEdit), isRead: asBoolean(row.isRead) })),
      total: countRows[0]?.total ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }

  async summary(actor: string) {
    const [rows] = await this.pool.execute<Array<RowDataPacket & Record<string, number>>>(
      `SELECT COUNT(*) AS todayChanges,
       COUNT(DISTINCT event.page_id) AS changedPages,
       COUNT(DISTINCT event.changed_by_key) AS changers,
       (SELECT COUNT(*) FROM confluence_pending_changes) AS unread
       FROM confluence_pending_changes event
       WHERE event.changed_at >= ?`,
      [dayStartIso()]
    );
    const row = rows[0] ?? {};
    return {
      todayChanges: Number(row.todayChanges ?? 0),
      unread: Number(row.unread ?? 0),
      changedPages: Number(row.changedPages ?? 0),
      changers: Number(row.changers ?? 0),
    };
  }

  async change(id: number, actor: string) {
    const [rows] = await this.pool.execute<Array<RowDataPacket & Record<string, unknown>>>(
      `SELECT event.id, event.page_id AS pageId, event.page_title AS pageTitle,
       event.space_key AS spaceKey, event.space_name AS spaceName,
       event.previous_version AS previousVersion, event.current_version AS currentVersion,
       event.changed_by_key AS changedByKey, event.changed_by_name AS changedByName,
       event.changed_at AS changedAt, event.version_message AS versionMessage,
       event.minor_edit AS minorEdit, event.confluence_url AS confluenceUrl,
       0 AS isRead
       FROM confluence_pending_changes event
       WHERE event.id = ?`,
      [id]
    );
    const row = rows[0];
    if (!row) throw Object.assign(new Error('Không tìm thấy thay đổi'), { statusCode: 404 });
    return { ...row, minorEdit: asBoolean(row.minorEdit), isRead: asBoolean(row.isRead) };
  }

  private async acceptPendingChange(connection: PoolConnection, change: RowDataPacket & Record<string, unknown>) {
    await connection.execute(
      `INSERT INTO confluence_pages
       (connection_id, page_id, page_title, space_key, space_name, current_version,
        changed_by_key, changed_by_name, changed_at, version_message, minor_edit, confluence_url, synced_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE page_title = VALUES(page_title), space_key = VALUES(space_key),
       space_name = VALUES(space_name), current_version = VALUES(current_version),
       changed_by_key = VALUES(changed_by_key), changed_by_name = VALUES(changed_by_name),
       changed_at = VALUES(changed_at), version_message = VALUES(version_message),
       minor_edit = VALUES(minor_edit), confluence_url = VALUES(confluence_url), synced_at = VALUES(synced_at)`,
      [
        String(change.pageId),
        String(change.pageTitle),
        String(change.spaceKey),
        String(change.spaceName),
        Number(change.currentVersion),
        String(change.changedByKey),
        String(change.changedByName),
        String(change.changedAt),
        String(change.versionMessage ?? ''),
        asBoolean(change.minorEdit) ? 1 : 0,
        String(change.confluenceUrl),
        new Date().toISOString(),
      ]
    );
    const [deleted] = await connection.execute<mysql.ResultSetHeader>(
      `DELETE FROM confluence_pending_changes
       WHERE connection_id = 1 AND page_id = ? AND current_version <= ?`,
      [String(change.pageId), Number(change.currentVersion)]
    );
    return deleted.affectedRows;
  }

  async markRead(id: number, _actor: string) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<Array<RowDataPacket & Record<string, unknown>>>(
        `SELECT id, page_id AS pageId, page_title AS pageTitle, space_key AS spaceKey, space_name AS spaceName,
         current_version AS currentVersion, changed_by_key AS changedByKey, changed_by_name AS changedByName,
         changed_at AS changedAt, version_message AS versionMessage, minor_edit AS minorEdit,
         confluence_url AS confluenceUrl FROM confluence_pending_changes WHERE id = ? FOR UPDATE`,
        [id]
      );
      if (!rows[0]) throw Object.assign(new Error('Thay đổi đã được áp dụng hoặc không tồn tại'), { statusCode: 404 });
      const applied = await this.acceptPendingChange(connection, rows[0]);
      await connection.commit();
      return { id, isRead: true, applied };
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }

  async markAllRead(_actor: string) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<Array<RowDataPacket & Record<string, unknown>>>(
        `SELECT id, page_id AS pageId, page_title AS pageTitle, space_key AS spaceKey, space_name AS spaceName,
         current_version AS currentVersion, changed_by_key AS changedByKey, changed_by_name AS changedByName,
         changed_at AS changedAt, version_message AS versionMessage, minor_edit AS minorEdit,
         confluence_url AS confluenceUrl FROM confluence_pending_changes ORDER BY page_id, current_version DESC FOR UPDATE`
      );
      const latestByPage = new Map<string, RowDataPacket & Record<string, unknown>>();
      for (const row of rows) if (!latestByPage.has(String(row.pageId))) latestByPage.set(String(row.pageId), row);
      let updated = 0;
      for (const row of latestByPage.values()) updated += await this.acceptPendingChange(connection, row);
      await connection.commit();
      return { updated };
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }

  async notifications(actor: string, limit = 8) {
    const changes = await this.changes(actor, { status: 'all', page: 1, limit: Math.min(20, limit) });
    const summary = await this.summary(actor);
    return { rows: changes.rows, unread: summary.unread };
  }

  private localSlot(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.config.CONFLUENCE_SYNC_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
    return { date: `${value('year')}-${value('month')}-${value('day')}`, time: `${value('hour')}:${value('minute')}` };
  }

  private async tick() {
    if (this.syncPromise) return;
    const settings = await this.settings();
    if (!settings.batchEnabled) return;
    const local = this.localSlot();
    if (![settings.firstSyncTime, settings.secondSyncTime].includes(local.time)) return;
    const slot = `${local.date}@${local.time}`;
    const [result] = await this.pool.execute<mysql.ResultSetHeader>(
      `UPDATE confluence_monitor_settings SET last_batch_slot = ?
       WHERE id = 1 AND (last_batch_slot IS NULL OR last_batch_slot <> ?)`,
      [slot, slot]
    );
    if (result.affectedRows) await this.sync(`batch:${slot}`).catch(() => undefined);
  }

  startScheduler() {
    if (this.scheduler) return;
    this.scheduler = setInterval(() => void this.tick(), 30_000);
    void this.tick();
  }

  async close() {
    if (this.scheduler) clearInterval(this.scheduler);
    await this.pool.end();
  }
}

export function registerConfluenceMonitorRoutes(app: FastifyInstance, monitor: ConfluenceMonitor, actorFor: ActorFor) {
  const idParams = z.object({ id: z.coerce.number().int().positive() });
  const ruleParams = z.object({ id: z.string().uuid() });

  app.get('/api/confluence-monitor/status', async () => monitor.connectionStatus());
  app.post('/api/confluence-monitor/connection/test', async () => monitor.testConnection());
  app.post('/api/confluence-monitor/webhook/register', async () => monitor.registerWebhook());
  app.post('/api/confluence/webhook', async (request) => monitor.processWebhook(request));
  app.get('/api/confluence-monitor/spaces', async (request) => {
    const query = z.object({ refresh: z.coerce.boolean().default(false) }).parse(request.query);
    return { rows: await monitor.spaces(query.refresh) };
  });
  app.get('/api/confluence-monitor/pages', async (request) => {
    const query = z
      .object({
        spaceKey: z.string().min(1).max(255),
        q: z.string().max(200).default(''),
        start: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(1000).default(1000),
      })
      .parse(request.query);
    return monitor.pages(query.spaceKey, query.q, query.start, query.limit);
  });
  app.get('/api/confluence-monitor/rules', async () => ({ rows: await monitor.rules() }));
  app.post('/api/confluence-monitor/rules', async (request) =>
    monitor.saveRule(undefined, ruleBody.parse(request.body), actorFor(request))
  );
  app.put('/api/confluence-monitor/rules/:id', async (request) =>
    monitor.saveRule(ruleParams.parse(request.params).id, ruleBody.parse(request.body), actorFor(request))
  );
  app.delete('/api/confluence-monitor/rules/:id', async (request) => {
    const deleted = await monitor.deleteRule(ruleParams.parse(request.params).id);
    if (!deleted) throw Object.assign(new Error('Không tìm thấy rule'), { statusCode: 404 });
    return { deleted: true };
  });
  app.get('/api/confluence-monitor/settings', async () => monitor.settings());
  app.put('/api/confluence-monitor/settings', async (request) =>
    monitor.saveSettings(settingsBody.parse(request.body))
  );
  app.post('/api/confluence-monitor/sync', async (request) => {
    const body = z
      .object({ spaceKeys: z.array(z.string().min(1).max(255)).max(100).optional() })
      .parse(request.body ?? {});
    return monitor.sync('manual', body.spaceKeys);
  });
  app.get('/api/confluence-monitor/summary', async (request) => monitor.summary(actorFor(request)));
  app.get('/api/confluence-monitor/changes', async (request) => monitor.changes(actorFor(request), request.query));
  app.get('/api/confluence-monitor/changes/:id', async (request) =>
    monitor.change(idParams.parse(request.params).id, actorFor(request))
  );
  app.patch('/api/confluence-monitor/changes/read-all', async (request) => monitor.markAllRead(actorFor(request)));
  app.patch('/api/confluence-monitor/changes/:id/read', async (request) =>
    monitor.markRead(idParams.parse(request.params).id, actorFor(request))
  );
  app.get('/api/confluence-monitor/notifications', async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(20).default(8) }).parse(request.query);
    return monitor.notifications(actorFor(request), query.limit);
  });
}
