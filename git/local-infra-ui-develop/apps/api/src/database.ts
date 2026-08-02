import mysql, { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
export type TaskEvent = { id: number; taskId: string; timestamp: string; stream: 'stdout' | 'stderr' | 'system'; text: string };
export type ManagedService = {
  id: string;
  name: string;
  runtime: 'go' | 'node' | 'vue';
  workingDir: string;
  env: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};
export type ManagedServiceEvent = { id: number; serviceId: string; timestamp: string; stream: 'stdout' | 'stderr' | 'system'; text: string };

type DatabaseConfig = { host: string; port: number; user: string; password: string; database: string };
type TaskRow = RowDataPacket & Record<string, unknown>;

const columnFor = (key: string) =>
  ({ status: 'status', startedAt: 'started_at', finishedAt: 'finished_at', durationMs: 'duration_ms', exitCode: 'exit_code', errorCode: 'error_code', errorMessage: 'error_message' } as Record<string, string>)[key];

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

  async initialize() {
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
    ];
    for (const statement of statements) await this.pool.query(statement);
  }

  async createTask(task: Record<string, unknown>) {
    await this.pool.execute(
      'INSERT INTO tasks (id, service_id, action_id, status, actor, request_id, params_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [task.id, task.serviceId, task.actionId, task.status, task.actor, task.requestId, task.paramsJson, task.createdAt] as any[]
    );
  }

  async updateTask(id: string, values: Record<string, unknown>) {
    const entries = Object.entries(values).map(([key, value]) => [columnFor(key), value] as const).filter((entry): entry is readonly [string, unknown] => Boolean(entry[0]));
    if (!entries.length) return;
    await this.pool.query(`UPDATE tasks SET ${entries.map(([column]) => `\`${column}\` = ?`).join(', ')} WHERE id = ?`, [...entries.map(([, value]) => value), id]);
  }

  async addEvent(event: Omit<TaskEvent, 'id'>): Promise<TaskEvent> {
    const [result] = await this.pool.execute<mysql.ResultSetHeader>('INSERT INTO task_events (task_id, timestamp, stream, text) VALUES (?, ?, ?, ?)', [event.taskId, event.timestamp, event.stream, event.text]);
    return { ...event, id: Number(result.insertId) };
  }

  async getTask(id: string) {
    const [rows] = await this.pool.execute<TaskRow[]>('SELECT * FROM tasks WHERE id = ?', [id]);
    return rows[0];
  }

  async getEvents(id: string, after = 0) {
    const [rows] = await this.pool.execute<Array<RowDataPacket & TaskEvent>>('SELECT id, task_id AS taskId, timestamp, stream, text FROM task_events WHERE task_id = ? AND id > ? ORDER BY id', [id, after]);
    return rows;
  }

  async listTasks(limit = 100, offset = 0, filters: { service?: string; status?: string; q?: string } = {}) {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filters.service) { where.push('service_id = ?'); values.push(filters.service); }
    if (filters.status) { where.push('status = ?'); values.push(filters.status); }
    if (filters.q?.trim()) { where.push('(id LIKE ? OR service_id LIKE ? OR action_id LIKE ? OR status LIKE ?)'); values.push(...Array(4).fill(`%${filters.q.trim()}%`)); }
    const [rows] = await this.pool.query<TaskRow[]>(`SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...values, limit, offset]);
    return rows;
  }

  async deleteTasks(ids: string[]) {
    if (!ids.length) return 0;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const placeholders = ids.map(() => '?').join(', ');
      const [rows] = await connection.execute<Array<RowDataPacket & { id: string }>>(`SELECT id FROM tasks WHERE id IN (${placeholders}) AND status NOT IN ('queued', 'running')`, ids);
      const removable = rows.map((row) => row.id);
      if (!removable.length) { await connection.commit(); return 0; }
      const removablePlaceholders = removable.map(() => '?').join(', ');
      await connection.execute(`DELETE FROM task_events WHERE task_id IN (${removablePlaceholders})`, removable);
      const [result] = await connection.execute<mysql.ResultSetHeader>(`DELETE FROM tasks WHERE id IN (${removablePlaceholders})`, removable);
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
    const [rows] = await this.pool.execute('SELECT id, name, instance_id AS instanceId, database_id AS databaseId, query_sql AS `sql`, created_at AS createdAt, updated_at AS updatedAt FROM spanner_saved_queries WHERE instance_id = ? AND database_id = ? ORDER BY updated_at DESC', [instanceId, databaseId]);
    return rows;
  }

  async saveSpannerQuery(query: { id: string; name: string; instanceId: string; databaseId: string; sql: string; createdAt: string; updatedAt: string }) {
    await this.pool.execute('INSERT INTO spanner_saved_queries (id, name, instance_id, database_id, query_sql, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), instance_id = VALUES(instance_id), database_id = VALUES(database_id), query_sql = VALUES(query_sql), updated_at = VALUES(updated_at)', [query.id, query.name, query.instanceId, query.databaseId, query.sql, query.createdAt, query.updatedAt]);
    return query;
  }

  async deleteSavedSpannerQuery(id: string) {
    const [result] = await this.pool.execute<mysql.ResultSetHeader>('DELETE FROM spanner_saved_queries WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async listManagedServices() {
    const [rows] = await this.pool.query<Array<RowDataPacket & { envJson: string }>>('SELECT id, name, runtime, working_dir AS workingDir, env_json AS envJson, created_at AS createdAt, updated_at AS updatedAt FROM managed_services ORDER BY name');
    return rows.map(({ envJson, ...service }) => ({ ...service, env: JSON.parse(envJson) })) as ManagedService[];
  }

  async getManagedService(id: string) {
    const [rows] = await this.pool.execute<Array<RowDataPacket & { envJson: string }>>('SELECT id, name, runtime, working_dir AS workingDir, env_json AS envJson, created_at AS createdAt, updated_at AS updatedAt FROM managed_services WHERE id = ?', [id]);
    const row = rows[0];
    return row ? ({ ...row, env: JSON.parse(row.envJson) } as unknown as ManagedService) : undefined;
  }

  async saveManagedService(service: ManagedService) {
    await this.pool.execute('INSERT INTO managed_services (id, name, runtime, working_dir, env_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), runtime = VALUES(runtime), working_dir = VALUES(working_dir), env_json = VALUES(env_json), updated_at = VALUES(updated_at)', [service.id, service.name, service.runtime, service.workingDir, JSON.stringify(service.env), service.createdAt, service.updatedAt]);
    return service;
  }

  async deleteManagedService(id: string) {
    const [result] = await this.pool.execute<mysql.ResultSetHeader>('DELETE FROM managed_services WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async addManagedServiceEvent(event: Omit<ManagedServiceEvent, 'id'>) {
    const [result] = await this.pool.execute<mysql.ResultSetHeader>('INSERT INTO managed_service_events (service_id, timestamp, stream, text) VALUES (?, ?, ?, ?)', [event.serviceId, event.timestamp, event.stream, event.text]);
    return { ...event, id: Number(result.insertId) };
  }

  async listManagedServiceEvents(serviceId: string, limit = 100) {
    const [rows] = await this.pool.execute<Array<RowDataPacket & ManagedServiceEvent>>('SELECT id, service_id AS serviceId, timestamp, stream, text FROM managed_service_events WHERE service_id = ? ORDER BY id DESC LIMIT ?', [serviceId, limit]);
    return rows.reverse();
  }
}
