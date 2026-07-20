import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

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
export class AuditDatabase {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        status TEXT NOT NULL,
        actor TEXT NOT NULL,
        request_id TEXT NOT NULL,
        params_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER,
        exit_code INTEGER,
        error_code TEXT,
        error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        stream TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_events_task_id_id ON task_events(task_id, id);
      CREATE INDEX IF NOT EXISTS tasks_created_at ON tasks(created_at DESC);
      CREATE TABLE IF NOT EXISTS spanner_saved_queries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        database_id TEXT NOT NULL,
        sql TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS spanner_saved_queries_database_updated_at
      ON spanner_saved_queries(instance_id, database_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS managed_services (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        runtime TEXT NOT NULL,
        working_dir TEXT NOT NULL,
        env_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS managed_service_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        stream TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS managed_service_events_service_id_id
      ON managed_service_events(service_id, id);
    `);
  }

  createTask(task: Record<string, unknown>) {
    this.db
      .prepare(
        `INSERT INTO tasks (id, service_id, action_id, status, actor, request_id, params_json, created_at)
      VALUES (@id, @serviceId, @actionId, @status, @actor, @requestId, @paramsJson, @createdAt)`
      )
      .run(task);
  }

  updateTask(id: string, values: Record<string, unknown>) {
    const columns = Object.keys(values);
    if (!columns.length) return;
    const set = columns
      .map((column) => `${column.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)} = @${column}`)
      .join(', ');
    this.db.prepare(`UPDATE tasks SET ${set} WHERE id = @id`).run({ id, ...values });
  }

  addEvent(event: Omit<TaskEvent, 'id'>): TaskEvent {
    const result = this.db
      .prepare(
        'INSERT INTO task_events (task_id, timestamp, stream, text) VALUES (@taskId, @timestamp, @stream, @text)'
      )
      .run(event);
    return { ...event, id: Number(result.lastInsertRowid) };
  }

  getTask(id: string) {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  }
  getEvents(id: string, after = 0) {
    return this.db
      .prepare(
        'SELECT id, task_id as taskId, timestamp, stream, text FROM task_events WHERE task_id = ? AND id > ? ORDER BY id'
      )
      .all(id, after) as TaskEvent[];
  }

  listTasks(limit = 100, offset = 0, filters: { service?: string; status?: string; q?: string } = {}) {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit, offset };
    if (filters.service) {
      where.push('service_id = @service');
      params.service = filters.service;
    }
    if (filters.status) {
      where.push('status = @status');
      params.status = filters.status;
    }
    if (filters.q?.trim()) {
      where.push(`(id LIKE @search OR service_id LIKE @search OR action_id LIKE @search OR status LIKE @search)`);
      params.search = `%${filters.q.trim()}%`;
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM tasks ${clause} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`)
      .all(params);
  }

  deleteTasks(ids: string[]) {
    if (!ids.length) return 0;
    const placeholders = ids.map(() => '?').join(', ');
    const removable = this.db
      .prepare(`SELECT id FROM tasks WHERE id IN (${placeholders}) AND status NOT IN ('queued', 'running')`)
      .all(...ids) as Array<{ id: string }>;
    if (!removable.length) return 0;
    const removableIds = removable.map((task) => task.id);
    const removablePlaceholders = removableIds.map(() => '?').join(', ');
    const remove = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM task_events WHERE task_id IN (${removablePlaceholders})`).run(...removableIds);
      return this.db.prepare(`DELETE FROM tasks WHERE id IN (${removablePlaceholders})`).run(...removableIds).changes;
    });
    return Number(remove());
  }

  listSavedSpannerQueries(instanceId: string, databaseId: string) {
    return this.db
      .prepare(
        `SELECT id, name, instance_id as instanceId, database_id as databaseId, sql,
        created_at as createdAt, updated_at as updatedAt
        FROM spanner_saved_queries WHERE instance_id = ? AND database_id = ? ORDER BY updated_at DESC`
      )
      .all(instanceId, databaseId);
  }

  saveSpannerQuery(query: {
    id: string;
    name: string;
    instanceId: string;
    databaseId: string;
    sql: string;
    createdAt: string;
    updatedAt: string;
  }) {
    this.db
      .prepare(
        `INSERT INTO spanner_saved_queries (id, name, instance_id, database_id, sql, created_at, updated_at)
        VALUES (@id, @name, @instanceId, @databaseId, @sql, @createdAt, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, instance_id = excluded.instance_id,
        database_id = excluded.database_id, sql = excluded.sql, updated_at = excluded.updated_at`
      )
      .run(query);
    return query;
  }

  deleteSavedSpannerQuery(id: string) {
    return this.db.prepare('DELETE FROM spanner_saved_queries WHERE id = ?').run(id).changes > 0;
  }

  listManagedServices() {
    return this.db
      .prepare(
        `SELECT id, name, runtime, working_dir as workingDir, env_json as envJson,
        created_at as createdAt, updated_at as updatedAt FROM managed_services ORDER BY name`
      )
      .all()
      .map((row: any) => ({ ...row, env: JSON.parse(row.envJson) })) as ManagedService[];
  }

  getManagedService(id: string) {
    const row = this.db
      .prepare(
        `SELECT id, name, runtime, working_dir as workingDir, env_json as envJson,
        created_at as createdAt, updated_at as updatedAt FROM managed_services WHERE id = ?`
      )
      .get(id) as any;
    return row ? ({ ...row, env: JSON.parse(row.envJson) } as ManagedService) : undefined;
  }

  saveManagedService(service: ManagedService) {
    this.db
      .prepare(
        `INSERT INTO managed_services (id, name, runtime, working_dir, env_json, created_at, updated_at)
        VALUES (@id, @name, @runtime, @workingDir, @envJson, @createdAt, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, runtime = excluded.runtime,
        working_dir = excluded.working_dir, env_json = excluded.env_json, updated_at = excluded.updated_at`
      )
      .run({ ...service, envJson: JSON.stringify(service.env) });
    return service;
  }

  deleteManagedService(id: string) {
    return this.db.prepare('DELETE FROM managed_services WHERE id = ?').run(id).changes > 0;
  }

  addManagedServiceEvent(event: Omit<ManagedServiceEvent, 'id'>) {
    const result = this.db
      .prepare(
        'INSERT INTO managed_service_events (service_id, timestamp, stream, text) VALUES (@serviceId, @timestamp, @stream, @text)'
      )
      .run(event);
    return { ...event, id: Number(result.lastInsertRowid) };
  }

  listManagedServiceEvents(serviceId: string, limit = 100) {
    return this.db
      .prepare(
        `SELECT id, service_id as serviceId, timestamp, stream, text FROM managed_service_events
        WHERE service_id = ? ORDER BY id DESC LIMIT ?`
      )
      .all(serviceId, limit)
      .reverse() as ManagedServiceEvent[];
  }
}
