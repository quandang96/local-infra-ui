import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AuditDatabase, type TaskEvent, type TaskStatus } from './database.js';

const secretPattern = /((?:password|token|secret|authorization|credential)\s*[=:]\s*)([^\s,;]+)/gi;
const bearerPattern = /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
export const maskSecrets = (value: string) =>
  value.replace(secretPattern, '$1***').replace(bearerPattern, 'Bearer ***');

export type Task = {
  id: string;
  serviceId: string;
  actionId: string;
  status: TaskStatus;
  actor: string;
  requestId: string;
  createdAt: string;
};

export class TaskRunner {
  private readonly running = new Map<string, ChildProcessWithoutNullStreams>();
  readonly events = new EventEmitter();

  constructor(private readonly database: AuditDatabase) {}

  async create(serviceId: string, actionId: string, actor: string, requestId: string, params: unknown): Promise<Task> {
    const task: Task = {
      id: `task_${randomUUID()}`,
      serviceId,
      actionId,
      status: 'queued',
      actor,
      requestId,
      createdAt: new Date().toISOString(),
    };
    await this.database.createTask({ ...task, paramsJson: JSON.stringify(params ?? {}) });
    return task;
  }

  async event(taskId: string, stream: TaskEvent['stream'], text: string) {
    const event = await this.database.addEvent({
      taskId,
      stream,
      text: maskSecrets(text),
      timestamp: new Date().toISOString(),
    });
    this.events.emit(`task:${taskId}`, event);
    return event;
  }

  async run(task: Task, command: string, args: string[], timeoutMs = 120_000) {
    const startedAt = new Date();
    await this.database.updateTask(task.id, { status: 'running', startedAt: startedAt.toISOString() });
    await this.event(task.id, 'system', `Starting approved action ${task.actionId}`);
    const child = spawn(command, args, { shell: false, cwd: process.cwd(), env: process.env });
    this.running.set(task.id, child);
    let outputBytes = 0;
    const capture = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      if (outputBytes >= 5 * 1024 * 1024) return;
      outputBytes += chunk.length;
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) void this.event(task.id, stream, line);
    };
    child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk));
    const timer = setTimeout(() => {
      void this.event(task.id, 'system', 'Task timed out; terminating process');
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      this.running.delete(task.id);
      const status: TaskStatus = signal === 'SIGTERM' ? 'cancelled' : exitCode === 0 ? 'succeeded' : 'failed';
      const durationMs = Date.now() - startedAt.getTime();
      void this.database.updateTask(task.id, {
        status,
        finishedAt: new Date().toISOString(),
        durationMs,
        exitCode: exitCode ?? -1,
      });
      void this.event(task.id, 'system', `Task ${status}; exit=${exitCode ?? signal ?? -1}; duration=${durationMs}ms`);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      this.running.delete(task.id);
      void this.database.updateTask(task.id, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        errorCode: 'PROCESS_ERROR',
        errorMessage: error.message,
      });
      void this.event(task.id, 'stderr', error.message);
    });
    return task;
  }

  cancel(taskId: string) {
    const child = this.running.get(taskId);
    if (!child) return false;
    void this.event(taskId, 'system', 'Cancellation requested');
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 5_000).unref();
    return true;
  }
}
