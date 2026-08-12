import mysql, { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
export type TaskEvent = {
  id: number;
  taskId: string;
  timestamp: string;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
};
export type ManagedService = {
  id: string;
  name: string;
  runtime: 'go' | 'node' | 'vue';
  workingDir: string;
  env: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};
export type ManagedServiceEvent = {
  id: number;
  serviceId: string;
  timestamp: string;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
};
export type JiraIssueInput = {
  jiraId: string;
  jiraKey: string;
  projectKey: string;
  summary: string;
  description?: string | null;
  issueType?: string | null;
  status: string;
  statusCategory: string;
  statusColor?: string | null;
  assigneeName?: string | null;
  priority?: string | null;
  sprint?: string | null;
  dueDate?: string | null;
  parentKey?: string | null;
  parentSummary?: string | null;
  labels?: string | null; // JSON array string
  startDate?: string | null;
  customFields?: string | null; // JSON object keyed by Jira field id
  jiraUpdatedAt: string;
  syncedAt: string;
  rawHash: string;
};
export type JiraWorklogInput = {
  id: string;
  jiraKey: string;
  authorName: string;
  authorAccountId?: string | null;
  timeSpentSeconds: number;
  started: string;
  comment?: string | null;
  syncedAt: string;
};
type JiraMultiFilter = string | string[] | undefined;

function filterValues(value: JiraMultiFilter): string[] {
  return (Array.isArray(value) ? value : value ? [value] : []).map((item) => item.trim()).filter(Boolean);
}
export type JiraCommentInput = {
  id: string;
  jiraKey: string;
  authorName: string;
  body?: string | null;
  createdAtJira: string;
  updatedAtJira: string;
  syncedAt: string;
};
export type JiraSettings = {
  jiraType: 'cloud' | 'data_center';
  baseUrl: string;
  jql: string;
  allowedProjects: string[];
  syncMode: 'manual' | 'interval';
  syncIntervalMinutes: number;
  staleDays: number;
  updatedAt: string;
};
export type JiraSettingsDefaults = Omit<JiraSettings, 'updatedAt'>;
export type Note = {
  id: string;
  title: string;
  content: string;
  tags: string[];
  isFavorite: boolean;
  isShared: boolean;
  shareToken: string | null;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

type DatabaseConfig = { host: string; port: number; user: string; password: string; database: string };
type TaskRow = RowDataPacket & Record<string, unknown>;

const columnFor = (key: string) =>
  (
    ({
      status: 'status',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
      durationMs: 'duration_ms',
      exitCode: 'exit_code',
      errorCode: 'error_code',
      errorMessage: 'error_message',
    }) as Record<string, string>
  )[key];

export class AuditDatabase {
  private readonly pool: Pool;

  constructor(config: DatabaseConfig) {
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      waitForConnections: true,
      connectionLimit: 10,
      charset: 'utf8mb4',
    });
  }

  async initialize(jiraDefaults: JiraSettingsDefaults) {
    const statements = [
      `
      CREATE TABLE IF NOT EXISTS tasks (
        id VARCHAR(80) PRIMARY KEY, service_id VARCHAR(80) NOT NULL, action_id VARCHAR(160) NOT NULL,
        status VARCHAR(32) NOT NULL, actor VARCHAR(255) NOT NULL, request_id VARCHAR(80) NOT NULL,
        params_json LONGTEXT NOT NULL, created_at VARCHAR(40) NOT NULL, started_at VARCHAR(40), finished_at VARCHAR(40),
        duration_ms BIGINT, exit_code INT, error_code VARCHAR(120), error_message TEXT,
        KEY tasks_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `
      CREATE TABLE IF NOT EXISTS task_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY, task_id VARCHAR(80) NOT NULL, timestamp VARCHAR(40) NOT NULL,
        stream VARCHAR(16) NOT NULL, text TEXT NOT NULL, KEY task_events_task_id_id (task_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `
      CREATE TABLE IF NOT EXISTS spanner_saved_queries (
        id VARCHAR(80) PRIMARY KEY, name VARCHAR(100) NOT NULL, instance_id VARCHAR(128) NOT NULL,
        database_id VARCHAR(128) NOT NULL, query_sql LONGTEXT NOT NULL, created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL, KEY spanner_saved_queries_database_updated_at (instance_id, database_id, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `
      CREATE TABLE IF NOT EXISTS managed_services (
        id VARCHAR(80) PRIMARY KEY, name VARCHAR(100) NOT NULL, runtime VARCHAR(16) NOT NULL,
        working_dir VARCHAR(300) NOT NULL, env_json LONGTEXT NOT NULL, created_at VARCHAR(40) NOT NULL, updated_at VARCHAR(40) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `
      CREATE TABLE IF NOT EXISTS managed_service_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY, service_id VARCHAR(80) NOT NULL, timestamp VARCHAR(40) NOT NULL,
        stream VARCHAR(16) NOT NULL, text TEXT NOT NULL, KEY managed_service_events_service_id_id (service_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `
      CREATE TABLE IF NOT EXISTS jira_issues (
        jira_id VARCHAR(80) NOT NULL, jira_key VARCHAR(80) PRIMARY KEY, project_key VARCHAR(80) NOT NULL,
        summary VARCHAR(500) NOT NULL, description TEXT, issue_type VARCHAR(100), status VARCHAR(100) NOT NULL,
        status_category VARCHAR(40) NOT NULL, status_color VARCHAR(40), assignee_name VARCHAR(255), priority VARCHAR(80), sprint VARCHAR(255),
        due_date VARCHAR(40), parent_key VARCHAR(80), parent_summary VARCHAR(500), labels TEXT,
        start_date VARCHAR(40), custom_fields TEXT, jira_updated_at VARCHAR(40) NOT NULL, synced_at VARCHAR(40) NOT NULL, raw_hash VARCHAR(64) NOT NULL,
        KEY jira_issues_project_status (project_key, status), KEY jira_issues_updated (jira_updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `
      CREATE TABLE IF NOT EXISTS jira_task_metadata (
        jira_key VARCHAR(80) PRIMARY KEY, report_note TEXT, internal_category VARCHAR(120), block_reason TEXT,
        highlight TINYINT(1) NOT NULL DEFAULT 0, risk TINYINT(1) NOT NULL DEFAULT 0,
        created_by VARCHAR(255) NOT NULL, updated_by VARCHAR(255) NOT NULL, created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `
      CREATE TABLE IF NOT EXISTS jira_settings (
        id TINYINT PRIMARY KEY, jira_type VARCHAR(20) NOT NULL, base_url VARCHAR(500) NOT NULL, jql TEXT NOT NULL,
        allowed_projects VARCHAR(500) NOT NULL, sync_mode VARCHAR(20) NOT NULL, sync_interval_minutes INT NOT NULL,
        stale_days INT NOT NULL, updated_at VARCHAR(40) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `
      CREATE TABLE IF NOT EXISTS jira_sync_runs (
        id VARCHAR(80) PRIMARY KEY, source VARCHAR(30) NOT NULL, started_at VARCHAR(40) NOT NULL, finished_at VARCHAR(40),
        status VARCHAR(30) NOT NULL, created_count INT NOT NULL DEFAULT 0, updated_count INT NOT NULL DEFAULT 0,
        unchanged_count INT NOT NULL DEFAULT 0, failed_count INT NOT NULL DEFAULT 0, error_summary TEXT,
        KEY jira_sync_runs_started (started_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `
      CREATE TABLE IF NOT EXISTS jira_audit_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY, actor VARCHAR(255) NOT NULL, action VARCHAR(120) NOT NULL,
        target_type VARCHAR(80) NOT NULL, target_id VARCHAR(80) NOT NULL, before_value LONGTEXT, after_value LONGTEXT,
        result VARCHAR(30) NOT NULL, created_at VARCHAR(40) NOT NULL, KEY jira_audit_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `
      CREATE TABLE IF NOT EXISTS jira_worklogs (
        id VARCHAR(80) PRIMARY KEY, jira_key VARCHAR(80) NOT NULL, author_name VARCHAR(255) NOT NULL,
        author_account_id VARCHAR(255), time_spent_seconds INT NOT NULL,
        started VARCHAR(40) NOT NULL, comment TEXT, synced_at VARCHAR(40) NOT NULL,
        KEY jira_worklogs_jira_key (jira_key),
        KEY jira_worklogs_author_started (author_name, started)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `
      CREATE TABLE IF NOT EXISTS jira_comments (
        id VARCHAR(80) PRIMARY KEY, jira_key VARCHAR(80) NOT NULL, author_name VARCHAR(255) NOT NULL,
        body TEXT, created_at_jira VARCHAR(40) NOT NULL, updated_at_jira VARCHAR(40) NOT NULL,
        synced_at VARCHAR(40) NOT NULL,
        KEY jira_comments_jira_key (jira_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `
      CREATE TABLE IF NOT EXISTS notes (
        id VARCHAR(80) PRIMARY KEY, title VARCHAR(240) NOT NULL, content LONGTEXT NOT NULL,
        tags_json TEXT NOT NULL, is_favorite TINYINT(1) NOT NULL DEFAULT 0,
        is_shared TINYINT(1) NOT NULL DEFAULT 0, share_token VARCHAR(80) UNIQUE,
        created_by VARCHAR(255) NOT NULL, updated_by VARCHAR(255) NOT NULL,
        created_at VARCHAR(40) NOT NULL, updated_at VARCHAR(40) NOT NULL,
        KEY notes_updated_at (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ];
    for (const statement of statements) await this.pool.query(statement);
    // ALTER TABLE migrations for columns added after initial schema.
    // Uses INFORMATION_SCHEMA check for MySQL 5.7 / MariaDB compatibility
    // (ADD COLUMN IF NOT EXISTS is only guaranteed from MySQL 8.0.3+).
    const columnMigrations: Array<{ column: string; ddl: string }> = [
      { column: 'parent_key', ddl: 'ALTER TABLE jira_issues ADD COLUMN parent_key VARCHAR(80) AFTER due_date' },
      {
        column: 'parent_summary',
        ddl: 'ALTER TABLE jira_issues ADD COLUMN parent_summary VARCHAR(500) AFTER parent_key',
      },
      { column: 'labels', ddl: 'ALTER TABLE jira_issues ADD COLUMN labels TEXT AFTER parent_summary' },
      { column: 'start_date', ddl: 'ALTER TABLE jira_issues ADD COLUMN start_date VARCHAR(40) AFTER labels' },
      {
        column: 'status_color',
        ddl: 'ALTER TABLE jira_issues ADD COLUMN status_color VARCHAR(40) AFTER status_category',
      },
      { column: 'custom_fields', ddl: 'ALTER TABLE jira_issues ADD COLUMN custom_fields TEXT AFTER start_date' },
    ];
    for (const { column, ddl } of columnMigrations) {
      const [rows] = await this.pool.execute<Array<RowDataPacket & { cnt: number }>>(
        `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jira_issues' AND COLUMN_NAME = ?`,
        [column]
      );
      if (!rows[0] || rows[0].cnt === 0) {
        await this.pool.query(ddl);
      }
    }
    const noteColumnMigrations: Array<{ column: string; ddl: string }> = [
      { column: 'tags_json', ddl: 'ALTER TABLE notes ADD COLUMN tags_json TEXT NOT NULL AFTER content' },
      {
        column: 'is_favorite',
        ddl: 'ALTER TABLE notes ADD COLUMN is_favorite TINYINT(1) NOT NULL DEFAULT 0 AFTER tags_json',
      },
    ];
    for (const { column, ddl } of noteColumnMigrations) {
      const [rows] = await this.pool.execute<Array<RowDataPacket & { cnt: number }>>(
        `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notes' AND COLUMN_NAME = ?`,
        [column]
      );
      if (!rows[0] || rows[0].cnt === 0) await this.pool.query(ddl);
    }
    await this.initializeJiraWorkspace(jiraDefaults);
  }

  private async initializeJiraWorkspace(defaults: JiraSettingsDefaults) {
    const now = new Date().toISOString();
    await this.pool.execute(
      `INSERT IGNORE INTO jira_settings
       (id, jira_type, base_url, jql, allowed_projects, sync_mode, sync_interval_minutes, stale_days, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        defaults.jiraType,
        defaults.baseUrl,
        defaults.jql,
        JSON.stringify(defaults.allowedProjects),
        defaults.syncMode,
        defaults.syncIntervalMinutes,
        defaults.staleDays,
        now,
      ]
    );

    // Migrate only the exact legacy placeholder configuration. User-provided
    // settings are never overwritten by environment defaults on restart.
    await this.pool.execute(
      `UPDATE jira_settings
       SET jira_type = ?, base_url = ?, jql = ?, allowed_projects = ?, sync_mode = ?,
           sync_interval_minutes = ?, stale_days = ?, updated_at = ?
       WHERE id = 1 AND jira_type = 'cloud'
         AND base_url = 'https://your-company.atlassian.net'
         AND jql = 'project = MEMBER ORDER BY updated DESC'
         AND allowed_projects = '["MEMBER"]'`,
      [
        defaults.jiraType,
        defaults.baseUrl,
        defaults.jql,
        JSON.stringify(defaults.allowedProjects),
        defaults.syncMode,
        defaults.syncIntervalMinutes,
        defaults.staleDays,
        now,
      ]
    );

    // Versions before the real Jira integration seeded fake MEMBER issues.
    // Remove only rows carrying that deterministic marker so the workspace can
    // never present mock data as if it came from Jira.
    await this.pool.execute(
      `DELETE metadata FROM jira_task_metadata metadata
       INNER JOIN jira_issues issue ON issue.jira_key = metadata.jira_key
       WHERE issue.raw_hash LIKE 'sample-%'`
    );
    await this.pool.execute("DELETE FROM jira_issues WHERE raw_hash LIKE 'sample-%'");
  }

  async createTask(task: Record<string, unknown>) {
    await this.pool.execute(
      'INSERT INTO tasks (id, service_id, action_id, status, actor, request_id, params_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        task.id,
        task.serviceId,
        task.actionId,
        task.status,
        task.actor,
        task.requestId,
        task.paramsJson,
        task.createdAt,
      ] as any[]
    );
  }

  async updateTask(id: string, values: Record<string, unknown>) {
    const entries = Object.entries(values)
      .map(([key, value]) => [columnFor(key), value] as const)
      .filter((entry): entry is readonly [string, unknown] => Boolean(entry[0]));
    if (!entries.length) return;
    await this.pool.query(
      `UPDATE tasks SET ${entries.map(([column]) => `\`${column}\` = ?`).join(', ')} WHERE id = ?`,
      [...entries.map(([, value]) => value), id]
    );
  }

  async addEvent(event: Omit<TaskEvent, 'id'>): Promise<TaskEvent> {
    const [result] = await this.pool.execute<mysql.ResultSetHeader>(
      'INSERT INTO task_events (task_id, timestamp, stream, text) VALUES (?, ?, ?, ?)',
      [event.taskId, event.timestamp, event.stream, event.text]
    );
    return { ...event, id: Number(result.insertId) };
  }

  async getTask(id: string) {
    const [rows] = await this.pool.execute<TaskRow[]>('SELECT * FROM tasks WHERE id = ?', [id]);
    return rows[0];
  }

  async getEvents(id: string, after = 0) {
    const [rows] = await this.pool.execute<Array<RowDataPacket & TaskEvent>>(
      'SELECT id, task_id AS taskId, timestamp, stream, text FROM task_events WHERE task_id = ? AND id > ? ORDER BY id',
      [id, after]
    );
    return rows;
  }

  async listTasks(limit = 100, offset = 0, filters: { service?: string; status?: string; q?: string } = {}) {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filters.service) {
      where.push('service_id = ?');
      values.push(filters.service);
    }
    if (filters.status) {
      where.push('status = ?');
      values.push(filters.status);
    }
    if (filters.q?.trim()) {
      where.push('(id LIKE ? OR service_id LIKE ? OR action_id LIKE ? OR status LIKE ?)');
      values.push(...Array(4).fill(`%${filters.q.trim()}%`));
    }
    const [rows] = await this.pool.query<TaskRow[]>(
      `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );
    return rows;
  }

  async deleteTasks(ids: string[]) {
    if (!ids.length) return 0;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const placeholders = ids.map(() => '?').join(', ');
      const [rows] = await connection.execute<Array<RowDataPacket & { id: string }>>(
        `SELECT id FROM tasks WHERE id IN (${placeholders}) AND status NOT IN ('queued', 'running')`,
        ids
      );
      const removable = rows.map((row) => row.id);
      if (!removable.length) {
        await connection.commit();
        return 0;
      }
      const removablePlaceholders = removable.map(() => '?').join(', ');
      await connection.execute(`DELETE FROM task_events WHERE task_id IN (${removablePlaceholders})`, removable);
      const [result] = await connection.execute<mysql.ResultSetHeader>(
        `DELETE FROM tasks WHERE id IN (${removablePlaceholders})`,
        removable
      );
      await connection.commit();
      return result.affectedRows;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async listSavedSpannerQueries(instanceId: string, databaseId: string) {
    const [rows] = await this.pool.execute(
      'SELECT id, name, instance_id AS instanceId, database_id AS databaseId, query_sql AS `sql`, created_at AS createdAt, updated_at AS updatedAt FROM spanner_saved_queries WHERE instance_id = ? AND database_id = ? ORDER BY updated_at DESC',
      [instanceId, databaseId]
    );
    return rows;
  }

  async saveSpannerQuery(query: {
    id: string;
    name: string;
    instanceId: string;
    databaseId: string;
    sql: string;
    createdAt: string;
    updatedAt: string;
  }) {
    await this.pool.execute(
      'INSERT INTO spanner_saved_queries (id, name, instance_id, database_id, query_sql, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), instance_id = VALUES(instance_id), database_id = VALUES(database_id), query_sql = VALUES(query_sql), updated_at = VALUES(updated_at)',
      [query.id, query.name, query.instanceId, query.databaseId, query.sql, query.createdAt, query.updatedAt]
    );
    return query;
  }

  async deleteSavedSpannerQuery(id: string) {
    const [result] = await this.pool.execute<mysql.ResultSetHeader>('DELETE FROM spanner_saved_queries WHERE id = ?', [
      id,
    ]);
    return result.affectedRows > 0;
  }

  async listManagedServices() {
    const [rows] = await this.pool.query<Array<RowDataPacket & { envJson: string }>>(
      'SELECT id, name, runtime, working_dir AS workingDir, env_json AS envJson, created_at AS createdAt, updated_at AS updatedAt FROM managed_services ORDER BY name'
    );
    return rows.map(({ envJson, ...service }) => ({ ...service, env: JSON.parse(envJson) })) as ManagedService[];
  }

  async getManagedService(id: string) {
    const [rows] = await this.pool.execute<Array<RowDataPacket & { envJson: string }>>(
      'SELECT id, name, runtime, working_dir AS workingDir, env_json AS envJson, created_at AS createdAt, updated_at AS updatedAt FROM managed_services WHERE id = ?',
      [id]
    );
    const row = rows[0];
    return row ? ({ ...row, env: JSON.parse(row.envJson) } as unknown as ManagedService) : undefined;
  }

  async saveManagedService(service: ManagedService) {
    await this.pool.execute(
      'INSERT INTO managed_services (id, name, runtime, working_dir, env_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), runtime = VALUES(runtime), working_dir = VALUES(working_dir), env_json = VALUES(env_json), updated_at = VALUES(updated_at)',
      [
        service.id,
        service.name,
        service.runtime,
        service.workingDir,
        JSON.stringify(service.env),
        service.createdAt,
        service.updatedAt,
      ]
    );
    return service;
  }

  async deleteManagedService(id: string) {
    const [result] = await this.pool.execute<mysql.ResultSetHeader>('DELETE FROM managed_services WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async listNotes() {
    const [rows] = await this.pool.query<Array<RowDataPacket & Omit<Note, 'tags'> & { tagsJson: string }>>(
      `SELECT id, title, content, tags_json AS tagsJson, is_favorite AS isFavorite,
       is_shared AS isShared, share_token AS shareToken,
       created_by AS createdBy, updated_by AS updatedBy, created_at AS createdAt, updated_at AS updatedAt
       FROM notes ORDER BY updated_at DESC`
    );
    return rows.map(({ tagsJson, ...note }) => ({
      ...note,
      tags: JSON.parse(tagsJson || '[]') as string[],
      isFavorite: Boolean(note.isFavorite),
      isShared: Boolean(note.isShared),
    }));
  }

  async listPublicNotes() {
    const [rows] = await this.pool.query<
      Array<
        RowDataPacket & {
          id: string;
          title: string;
          content: string;
          tagsJson: string;
          isFavorite: number;
          createdAt: string;
          updatedAt: string;
        }
      >
    >(
      `SELECT id, title, content, tags_json AS tagsJson, is_favorite AS isFavorite,
       created_at AS createdAt, updated_at AS updatedAt
       FROM notes WHERE is_shared = 1 ORDER BY updated_at DESC`
    );
    return rows.map(({ tagsJson, ...note }) => ({
      ...note,
      tags: JSON.parse(tagsJson || '[]') as string[],
      isFavorite: Boolean(note.isFavorite),
      isShared: true,
      shareToken: null,
    }));
  }

  async getNote(id: string) {
    const [rows] = await this.pool.execute<Array<RowDataPacket & Omit<Note, 'tags'> & { tagsJson: string }>>(
      `SELECT id, title, content, tags_json AS tagsJson, is_favorite AS isFavorite,
       is_shared AS isShared, share_token AS shareToken,
       created_by AS createdBy, updated_by AS updatedBy, created_at AS createdAt, updated_at AS updatedAt
       FROM notes WHERE id = ?`,
      [id]
    );
    const row = rows[0];
    if (!row) return undefined;
    const { tagsJson, ...note } = row;
    return {
      ...note,
      tags: JSON.parse(tagsJson || '[]') as string[],
      isFavorite: Boolean(note.isFavorite),
      isShared: Boolean(note.isShared),
    };
  }

  async saveNote(note: Note) {
    await this.pool.execute(
      `INSERT INTO notes
       (id, title, content, tags_json, is_favorite, is_shared, share_token, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE title = VALUES(title), content = VALUES(content), tags_json = VALUES(tags_json),
       is_favorite = VALUES(is_favorite), is_shared = VALUES(is_shared), share_token = VALUES(share_token),
       updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
      [
        note.id,
        note.title,
        note.content,
        JSON.stringify(note.tags),
        note.isFavorite ? 1 : 0,
        note.isShared ? 1 : 0,
        note.shareToken,
        note.createdBy,
        note.updatedBy,
        note.createdAt,
        note.updatedAt,
      ]
    );
    return note;
  }

  async deleteNote(id: string) {
    const [result] = await this.pool.execute<mysql.ResultSetHeader>('DELETE FROM notes WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async addManagedServiceEvent(event: Omit<ManagedServiceEvent, 'id'>) {
    const [result] = await this.pool.execute<mysql.ResultSetHeader>(
      'INSERT INTO managed_service_events (service_id, timestamp, stream, text) VALUES (?, ?, ?, ?)',
      [event.serviceId, event.timestamp, event.stream, event.text]
    );
    return { ...event, id: Number(result.insertId) };
  }

  async listManagedServiceEvents(serviceId: string, limit = 100) {
    const [rows] = await this.pool.execute<Array<RowDataPacket & ManagedServiceEvent>>(
      'SELECT id, service_id AS serviceId, timestamp, stream, text FROM managed_service_events WHERE service_id = ? ORDER BY id DESC LIMIT ?',
      [serviceId, limit]
    );
    return rows.reverse();
  }

  async listJiraIssues(
    filters: {
      q?: string;
      status?: string;
      assignee?: string;
      priority?: string;
      sprint?: JiraMultiFilter;
      parentKey?: JiraMultiFilter;
    } = {}
  ) {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filters.q?.trim()) {
      where.push('(i.jira_key LIKE ? OR i.summary LIKE ?)');
      values.push(`%${filters.q.trim()}%`, `%${filters.q.trim()}%`);
    }
    for (const [key, column] of [
      ['status', 'i.status'],
      ['assignee', 'i.assignee_name'],
      ['priority', 'i.priority'],
      ['sprint', 'i.sprint'],
      ['parentKey', 'i.parent_key'],
    ] as const) {
      const selected = filterValues(filters[key]);
      if (selected.length) {
        where.push(`${column} IN (${selected.map(() => '?').join(', ')})`);
        values.push(...selected);
      }
    }
    const [rows] = await this.pool.query<TaskRow[]>(
      `SELECT i.jira_id AS jiraId, i.jira_key AS jiraKey, i.project_key AS projectKey, i.summary,
       i.description, i.issue_type AS issueType, i.status, i.status_category AS statusCategory, i.status_color AS statusColor,
       i.assignee_name AS assigneeName, i.priority, i.sprint, i.due_date AS dueDate,
       i.parent_key AS parentKey, i.parent_summary AS parentSummary,
       i.labels, i.start_date AS startDate, i.custom_fields AS customFields,
       i.jira_updated_at AS jiraUpdatedAt, i.synced_at AS syncedAt,
       m.report_note AS reportNote, m.internal_category AS internalCategory, m.block_reason AS blockReason,
       COALESCE(m.highlight, 0) AS highlight, COALESCE(m.risk, 0) AS risk
       FROM jira_issues i LEFT JOIN jira_task_metadata m ON m.jira_key = i.jira_key
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY i.jira_updated_at DESC LIMIT 500`,
      values
    );
    return rows;
  }

  async getJiraIssue(jiraKey: string) {
    const rows = await this.listJiraIssues({ q: jiraKey });
    return rows.find((row: any) => row.jiraKey === jiraKey);
  }

  async jiraDashboard(staleDays: number) {
    const cutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString();
    const weekStart = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const [counts] = await this.pool.execute<Array<RowDataPacket & Record<string, number>>>(
      `SELECT COUNT(*) AS total,
       SUM(status_category <> 'done') AS open,
       SUM(status_category <> 'done' AND LOWER(status) LIKE '%progress%') AS inProgress,
       SUM(LOWER(status) LIKE '%block%') AS blocked,
       SUM(status_category = 'done' AND jira_updated_at >= ?) AS doneThisWeek,
       SUM(status_category <> 'done' AND jira_updated_at < ?) AS stale,
       SUM(status_category <> 'done' AND due_date IS NOT NULL AND due_date < CURDATE()) AS overdue
       FROM jira_issues`,
      [weekStart, cutoff]
    );
    const [syncRows] = await this.pool.query<TaskRow[]>(
      'SELECT * FROM jira_sync_runs ORDER BY started_at DESC LIMIT 1'
    );
    return {
      metrics: counts[0],
      lastSync: syncRows[0] ?? null,
      recentIssues: (await this.listJiraIssues()).slice(0, 5),
    };
  }

  async saveJiraMetadata(
    jiraKey: string,
    metadata: { reportNote: string; internalCategory: string; blockReason: string; highlight: boolean; risk: boolean },
    actor: string
  ) {
    const now = new Date().toISOString();
    await this.pool.execute(
      `INSERT INTO jira_task_metadata
       (jira_key, report_note, internal_category, block_reason, highlight, risk, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE report_note = VALUES(report_note), internal_category = VALUES(internal_category),
       block_reason = VALUES(block_reason), highlight = VALUES(highlight), risk = VALUES(risk),
       updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
      [
        jiraKey,
        metadata.reportNote,
        metadata.internalCategory,
        metadata.blockReason,
        metadata.highlight ? 1 : 0,
        metadata.risk ? 1 : 0,
        actor,
        actor,
        now,
        now,
      ]
    );
    return this.getJiraIssue(jiraKey);
  }

  async upsertJiraIssues(issues: JiraIssueInput[], reconciledProjects: string[] = []) {
    let created = 0,
      updated = 0,
      unchanged = 0,
      deleted = 0;
    let deletedWorklogs = 0,
      deletedComments = 0,
      deletedMetadata = 0;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const issue of issues) {
        const [current] = await connection.execute<Array<RowDataPacket & { rawHash: string }>>(
          'SELECT raw_hash AS rawHash FROM jira_issues WHERE jira_key = ?',
          [issue.jiraKey]
        );
        if (!current.length) created += 1;
        else if (current[0].rawHash === issue.rawHash) unchanged += 1;
        else updated += 1;
        await connection.execute(
          `INSERT INTO jira_issues
           (jira_id, jira_key, project_key, summary, description, issue_type, status, status_category, status_color,
            assignee_name, priority, sprint, due_date, parent_key, parent_summary, labels, start_date, custom_fields,
            jira_updated_at, synced_at, raw_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE jira_id = VALUES(jira_id), project_key = VALUES(project_key), summary = VALUES(summary),
           description = VALUES(description), issue_type = VALUES(issue_type), status = VALUES(status),
           status_category = VALUES(status_category), status_color = VALUES(status_color), assignee_name = VALUES(assignee_name), priority = VALUES(priority),
           sprint = VALUES(sprint), due_date = VALUES(due_date), parent_key = VALUES(parent_key),
           parent_summary = VALUES(parent_summary), labels = VALUES(labels), start_date = VALUES(start_date), custom_fields = VALUES(custom_fields),
           jira_updated_at = VALUES(jira_updated_at), synced_at = VALUES(synced_at), raw_hash = VALUES(raw_hash)`,
          [
            issue.jiraId,
            issue.jiraKey,
            issue.projectKey,
            issue.summary,
            issue.description ?? null,
            issue.issueType ?? null,
            issue.status,
            issue.statusCategory,
            issue.statusColor ?? null,
            issue.assigneeName ?? null,
            issue.priority ?? null,
            issue.sprint ?? null,
            issue.dueDate ?? null,
            issue.parentKey ?? null,
            issue.parentSummary ?? null,
            issue.labels ?? null,
            issue.startDate ?? null,
            issue.customFields ?? null,
            issue.jiraUpdatedAt,
            issue.syncedAt,
            issue.rawHash,
          ]
        );
      }
      if (reconciledProjects.length) {
        const projectPlaceholders = reconciledProjects.map(() => '?').join(', ');
        const issueKeys = issues.map((issue) => issue.jiraKey);
        const keyClause = issueKeys.length ? ` AND jira_key NOT IN (${issueKeys.map(() => '?').join(', ')})` : '';
        const [staleRows] = await connection.execute<Array<RowDataPacket & { jiraKey: string }>>(
          `SELECT jira_key AS jiraKey FROM jira_issues WHERE project_key IN (${projectPlaceholders})${keyClause}`,
          [...reconciledProjects, ...issueKeys]
        );
        const staleIssueKeys = staleRows.map((row) => row.jiraKey);
        if (staleIssueKeys.length) {
          const stalePlaceholders = staleIssueKeys.map(() => '?').join(', ');
          const [worklogResult] = await connection.execute(
            `DELETE FROM jira_worklogs WHERE jira_key IN (${stalePlaceholders})`,
            staleIssueKeys
          );
          const [commentResult] = await connection.execute(
            `DELETE FROM jira_comments WHERE jira_key IN (${stalePlaceholders})`,
            staleIssueKeys
          );
          const [metadataResult] = await connection.execute(
            `DELETE FROM jira_task_metadata WHERE jira_key IN (${stalePlaceholders})`,
            staleIssueKeys
          );
          const [issueResult] = await connection.execute(
            `DELETE FROM jira_issues WHERE jira_key IN (${stalePlaceholders})`,
            staleIssueKeys
          );
          deletedWorklogs = Number((worklogResult as { affectedRows?: number }).affectedRows ?? 0);
          deletedComments = Number((commentResult as { affectedRows?: number }).affectedRows ?? 0);
          deletedMetadata = Number((metadataResult as { affectedRows?: number }).affectedRows ?? 0);
          deleted = Number((issueResult as { affectedRows?: number }).affectedRows ?? 0);
        }
      }
      await connection.commit();
      return { created, updated, unchanged, deleted, deletedWorklogs, deletedComments, deletedMetadata };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getJiraSettings(): Promise<JiraSettings> {
    const [rows] = await this.pool.query<TaskRow[]>('SELECT * FROM jira_settings WHERE id = 1');
    const row: any = rows[0];
    return {
      jiraType: row.jira_type,
      baseUrl: row.base_url,
      jql: row.jql,
      allowedProjects: JSON.parse(row.allowed_projects || '[]'),
      syncMode: row.sync_mode,
      syncIntervalMinutes: Number(row.sync_interval_minutes),
      staleDays: Number(row.stale_days),
      updatedAt: row.updated_at,
    };
  }

  async saveJiraSettings(settings: JiraSettings) {
    await this.pool.execute(
      `UPDATE jira_settings SET jira_type = ?, base_url = ?, jql = ?, allowed_projects = ?, sync_mode = ?,
       sync_interval_minutes = ?, stale_days = ?, updated_at = ? WHERE id = 1`,
      [
        settings.jiraType,
        settings.baseUrl,
        settings.jql,
        JSON.stringify(settings.allowedProjects),
        settings.syncMode,
        settings.syncIntervalMinutes,
        settings.staleDays,
        settings.updatedAt,
      ]
    );
    return this.getJiraSettings();
  }

  async addJiraAudit(
    actor: string,
    action: string,
    targetType: string,
    targetId: string,
    before: unknown,
    after: unknown,
    result = 'success'
  ) {
    await this.pool.execute(
      `INSERT INTO jira_audit_logs (actor, action, target_type, target_id, before_value, after_value, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actor,
        action,
        targetType,
        targetId,
        before == null ? null : JSON.stringify(before),
        after == null ? null : JSON.stringify(after),
        result,
        new Date().toISOString(),
      ]
    );
  }

  async listJiraAudit(limit = 30) {
    const [rows] = await this.pool.execute<TaskRow[]>(
      `SELECT id, actor, action, target_type AS targetType, target_id AS targetId, result, created_at AS createdAt
       FROM jira_audit_logs ORDER BY id DESC LIMIT ?`,
      [limit]
    );
    return rows;
  }

  async createJiraSyncRun(id: string, source: string, startedAt: string) {
    await this.pool.execute(`INSERT INTO jira_sync_runs (id, source, started_at, status) VALUES (?, ?, ?, 'running')`, [
      id,
      source,
      startedAt,
    ]);
  }

  async finishJiraSyncRun(
    id: string,
    values: { status: string; created?: number; updated?: number; unchanged?: number; failed?: number; error?: string }
  ) {
    await this.pool.execute(
      `UPDATE jira_sync_runs SET finished_at = ?, status = ?, created_count = ?, updated_count = ?,
       unchanged_count = ?, failed_count = ?, error_summary = ? WHERE id = ?`,
      [
        new Date().toISOString(),
        values.status,
        values.created ?? 0,
        values.updated ?? 0,
        values.unchanged ?? 0,
        values.failed ?? 0,
        values.error ?? null,
        id,
      ]
    );
  }

  async listJiraSyncRuns(limit = 20) {
    const [rows] = await this.pool.execute<TaskRow[]>(
      `SELECT id, source, started_at AS startedAt, finished_at AS finishedAt, status,
       created_count AS createdCount, updated_count AS updatedCount, unchanged_count AS unchangedCount,
       failed_count AS failedCount, error_summary AS errorSummary
       FROM jira_sync_runs ORDER BY started_at DESC LIMIT ?`,
      [limit]
    );
    return rows;
  }

  async upsertJiraWorklogs(worklogs: JiraWorklogInput[]) {
    if (!worklogs.length) return;
    for (const w of worklogs) {
      await this.pool.execute(
        `INSERT INTO jira_worklogs
         (id, jira_key, author_name, author_account_id, time_spent_seconds, started, comment, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE jira_key = VALUES(jira_key), author_name = VALUES(author_name),
         author_account_id = VALUES(author_account_id), time_spent_seconds = VALUES(time_spent_seconds),
         started = VALUES(started), comment = VALUES(comment), synced_at = VALUES(synced_at)`,
        [
          w.id,
          w.jiraKey,
          w.authorName,
          w.authorAccountId ?? null,
          w.timeSpentSeconds,
          w.started,
          w.comment ?? null,
          w.syncedAt,
        ]
      );
    }
  }

  async upsertJiraComments(comments: JiraCommentInput[]) {
    if (!comments.length) return;
    for (const c of comments) {
      await this.pool.execute(
        `INSERT INTO jira_comments
         (id, jira_key, author_name, body, created_at_jira, updated_at_jira, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE author_name = VALUES(author_name), body = VALUES(body),
         updated_at_jira = VALUES(updated_at_jira), synced_at = VALUES(synced_at)`,
        [c.id, c.jiraKey, c.authorName, c.body ?? null, c.createdAtJira, c.updatedAtJira, c.syncedAt]
      );
    }
  }

  async reconcileJiraWorklogs(jiraKeys: string[], syncedAt: string) {
    if (!jiraKeys.length) return 0;
    const placeholders = jiraKeys.map(() => '?').join(', ');
    const [result] = await this.pool.execute(
      `DELETE FROM jira_worklogs WHERE jira_key IN (${placeholders}) AND synced_at <> ?`,
      [...jiraKeys, syncedAt]
    );
    return Number((result as { affectedRows?: number }).affectedRows ?? 0);
  }

  async reconcileJiraComments(jiraKeys: string[], syncedAt: string) {
    if (!jiraKeys.length) return 0;
    const placeholders = jiraKeys.map(() => '?').join(', ');
    const [result] = await this.pool.execute(
      `DELETE FROM jira_comments WHERE jira_key IN (${placeholders}) AND synced_at <> ?`,
      [...jiraKeys, syncedAt]
    );
    return Number((result as { affectedRows?: number }).affectedRows ?? 0);
  }

  async listJiraWorklogs(filters: { jiraKey?: string; assignee?: string; dateFrom?: string; dateTo?: string } = {}) {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filters.jiraKey) {
      where.push('jira_key = ?');
      values.push(filters.jiraKey);
    }
    if (filters.assignee) {
      where.push('author_name = ?');
      values.push(filters.assignee);
    }
    if (filters.dateFrom) {
      where.push('started >= ?');
      values.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      where.push('started <= ?');
      values.push(filters.dateTo + 'T23:59:59');
    }
    const [rows] = await this.pool.query<TaskRow[]>(
      `SELECT id, jira_key AS jiraKey, author_name AS authorName, author_account_id AS authorAccountId,
       time_spent_seconds AS timeSpentSeconds, started, comment, synced_at AS syncedAt
       FROM jira_worklogs
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY started DESC LIMIT 2000`,
      values
    );
    return rows;
  }

  async listJiraComments(jiraKey: string) {
    const [rows] = await this.pool.query<TaskRow[]>(
      `SELECT id, jira_key AS jiraKey, author_name AS authorName, body,
       created_at_jira AS createdAtJira, updated_at_jira AS updatedAtJira, synced_at AS syncedAt
       FROM jira_comments WHERE jira_key = ? ORDER BY created_at_jira ASC`,
      [jiraKey]
    );
    return rows;
  }

  async worklogReportByMemberByDay(
    dateFrom: string,
    dateTo: string,
    authorName?: string,
    sprint?: JiraMultiFilter,
    parentKey?: JiraMultiFilter
  ) {
    // Returns rows: { authorName, day (YYYY-MM-DD string), totalSeconds, issueCount }
    const where = ['w.started >= ?', 'w.started <= ?'];
    const values: unknown[] = [dateFrom, dateTo + 'T23:59:59'];
    if (authorName) {
      where.push('w.author_name = ?');
      values.push(authorName);
    }
    const selectedSprints = filterValues(sprint);
    if (selectedSprints.length) {
      where.push(`i.sprint IN (${selectedSprints.map(() => '?').join(', ')})`);
      values.push(...selectedSprints);
    }
    const selectedParents = filterValues(parentKey);
    if (selectedParents.length) {
      where.push(`i.parent_key IN (${selectedParents.map(() => '?').join(', ')})`);
      values.push(...selectedParents);
    }
    const [rows] = await this.pool.query<TaskRow[]>(
      `SELECT w.author_name AS authorName,
       DATE_FORMAT(w.started, '%Y-%m-%d') AS day,
       SUM(w.time_spent_seconds) AS totalSeconds,
       COUNT(DISTINCT w.jira_key) AS issueCount
       FROM jira_worklogs w INNER JOIN jira_issues i ON i.jira_key = w.jira_key
       WHERE ${where.join(' AND ')}
       GROUP BY w.author_name, DATE_FORMAT(w.started, '%Y-%m-%d')
       ORDER BY w.author_name, day`,
      values
    );
    return rows;
  }

  async worklogReportByTicket(
    dateFrom: string,
    dateTo: string,
    authorName?: string,
    jiraKey?: string,
    assignee?: string,
    sprint?: JiraMultiFilter,
    parentKey?: JiraMultiFilter
  ) {
    // Returns rows: { jiraKey, authorName, day (YYYY-MM-DD string), totalSeconds }
    const where: string[] = ['w.started >= ?', 'w.started <= ?'];
    const values: unknown[] = [dateFrom, dateTo + 'T23:59:59'];
    if (authorName) {
      where.push('w.author_name = ?');
      values.push(authorName);
    }
    if (jiraKey) {
      where.push('w.jira_key = ?');
      values.push(jiraKey);
    }
    if (assignee) {
      where.push('i.assignee_name = ?');
      values.push(assignee);
    }
    const selectedSprints = filterValues(sprint);
    if (selectedSprints.length) {
      where.push(`i.sprint IN (${selectedSprints.map(() => '?').join(', ')})`);
      values.push(...selectedSprints);
    }
    const selectedParents = filterValues(parentKey);
    if (selectedParents.length) {
      where.push(`i.parent_key IN (${selectedParents.map(() => '?').join(', ')})`);
      values.push(...selectedParents);
    }
    const [rows] = await this.pool.query<TaskRow[]>(
      `SELECT w.jira_key AS jiraKey,
       w.author_name AS authorName,
       DATE_FORMAT(w.started, '%Y-%m-%d') AS day,
       SUM(w.time_spent_seconds) AS totalSeconds
       FROM jira_worklogs w INNER JOIN jira_issues i ON i.jira_key = w.jira_key
       WHERE ${where.join(' AND ')}
       GROUP BY w.jira_key, w.author_name, DATE_FORMAT(w.started, '%Y-%m-%d')
       ORDER BY w.jira_key, w.author_name, day`,
      values
    );
    return rows;
  }

  async deleteWorklogsForKeys(jiraKeys: string[]) {
    if (!jiraKeys.length) return;
    const placeholders = jiraKeys.map(() => '?').join(', ');
    await this.pool.query(`DELETE FROM jira_worklogs WHERE jira_key IN (${placeholders})`, jiraKeys);
  }

  async deleteCommentsForKeys(jiraKeys: string[]) {
    if (!jiraKeys.length) return;
    const placeholders = jiraKeys.map(() => '?').join(', ');
    await this.pool.query(`DELETE FROM jira_comments WHERE jira_key IN (${placeholders})`, jiraKeys);
  }
}
