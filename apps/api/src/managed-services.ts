import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { AuditDatabase, type ManagedService, type ManagedServiceEvent } from './database.js';
import { maskSecrets } from './task-runner.js';

type RunningService = { child: ChildProcessWithoutNullStreams; startedAt: string };

const commandFor = (service: ManagedService) => {
  if (service.runtime === 'go') return { command: 'make', args: ['run'], label: 'make run' };
  if (service.runtime === 'node') return { command: 'npm', args: ['run', 'dev'], label: 'npm run dev' };
  const port = service.env.PORT || '5173';
  return {
    command: 'npm',
    args: ['run', 'dev', '--', '--host', '0.0.0.0', '--port', port],
    label: `npm run dev -- --host 0.0.0.0 --port ${port}`,
  };
};

export class ManagedServiceRunner {
  private readonly running = new Map<string, RunningService>();
  readonly events = new EventEmitter();

  constructor(
    private readonly database: AuditDatabase,
    private readonly workspaceDir: string
  ) {}

  command(service: ManagedService) {
    return commandFor(service);
  }

  status(service: ManagedService) {
    const running = this.running.get(service.id);
    return {
      ...service,
      command: this.command(service).label,
      status: running ? 'running' : 'stopped',
      startedAt: running?.startedAt ?? null,
    };
  }

  list() {
    return this.database.listManagedServices().map((service) => this.status(service));
  }

  get(id: string) {
    const service = this.database.getManagedService(id);
    return service ? this.status(service) : undefined;
  }

  private cwdFor(service: ManagedService) {
    const cwd = resolve(this.workspaceDir, service.workingDir);
    const pathFromWorkspace = relative(this.workspaceDir, cwd);
    if (!pathFromWorkspace || pathFromWorkspace.startsWith('..') || isAbsolute(pathFromWorkspace))
      throw Object.assign(new Error('Working directory must be inside the workspace'), { statusCode: 400 });
    return cwd;
  }

  private event(serviceId: string, stream: ManagedServiceEvent['stream'], text: string) {
    const event = this.database.addManagedServiceEvent({
      serviceId,
      stream,
      text: maskSecrets(text),
      timestamp: new Date().toISOString(),
    });
    this.events.emit(`service:${serviceId}`, event);
    return event;
  }

  private capture(serviceId: string, stream: 'stdout' | 'stderr', chunk: Buffer) {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) this.event(serviceId, stream, line);
  }

  private signal(running: RunningService, signal: NodeJS.Signals) {
    if (process.platform !== 'win32' && running.child.pid) process.kill(-running.child.pid, signal);
    else running.child.kill(signal);
  }

  start(id: string) {
    const service = this.database.getManagedService(id);
    if (!service) throw Object.assign(new Error('Managed service not found'), { statusCode: 404 });
    if (this.running.has(id)) return this.status(service);
    const command = this.command(service);
    const cwd = this.cwdFor(service);
    const child = spawn(command.command, command.args, {
      cwd,
      env: { ...process.env, ...service.env },
      shell: false,
      detached: process.platform !== 'win32',
    });
    const startedAt = new Date().toISOString();
    this.running.set(id, { child, startedAt });
    this.event(id, 'system', `Starting ${command.label} in ${service.workingDir}`);
    child.stdout.on('data', (chunk: Buffer) => this.capture(id, 'stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => this.capture(id, 'stderr', chunk));
    child.on('error', (error) => this.event(id, 'stderr', error.message));
    child.on('close', (code, signal) => {
      this.running.delete(id);
      this.event(id, 'system', `Service stopped; exit=${code ?? signal ?? -1}`);
      this.events.emit(`status:${id}`, this.status(service));
    });
    this.events.emit(`status:${id}`, this.status(service));
    return this.status(service);
  }

  async stop(id: string) {
    const service = this.database.getManagedService(id);
    if (!service) throw Object.assign(new Error('Managed service not found'), { statusCode: 404 });
    const running = this.running.get(id);
    if (!running) return this.status(service);
    this.event(id, 'system', 'Stop requested');
    await new Promise<void>((done) => {
      const timer = setTimeout(() => this.signal(running, 'SIGKILL'), 5_000);
      running.child.once('close', () => {
        clearTimeout(timer);
        done();
      });
      this.signal(running, 'SIGTERM');
    });
    return this.status(service);
  }

  async restart(id: string) {
    await this.stop(id);
    return this.start(id);
  }

  eventsFor(id: string, tail: number) {
    return this.database.listManagedServiceEvents(id, tail);
  }
}
