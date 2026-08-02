import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { config } from './config.js';
import { AuditDatabase } from './database.js';
import { Infrastructure } from './infra.js';
import { registerJiraRoutes } from './jira-routes.js';
import { ManagedServiceRunner } from './managed-services.js';
import { TaskRunner } from './task-runner.js';

const database = new AuditDatabase({
  host: config.MYSQL_HOST,
  port: config.MYSQL_PORT,
  user: config.MYSQL_USER,
  password: config.MYSQL_PASSWORD,
  database: config.MYSQL_DATABASE,
});
await database.initialize();
const infra = new Infrastructure(config);
const tasks = new TaskRunner(database);
const app = Fastify({ logger: true, genReqId: () => randomUUID() });
const managedServices = new ManagedServiceRunner(database, config.WORKSPACE_DIR);

app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, (_request, body, done) => {
  done(null, body);
});

const normaliseOrigin = (value: string) => {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

const allowedOrigins = new Set(
  config.ALLOWED_ORIGIN.split(',')
    .map((origin) => normaliseOrigin(origin.trim()))
    .filter((origin): origin is string => Boolean(origin))
);

const firstHeaderValue = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

function isSameOrigin(origin: string, request: FastifyRequest) {
  const forwardedProtocol = config.TRUST_CODER_PROXY
    ? firstHeaderValue(request.headers['x-forwarded-proto'])?.split(',')[0]?.trim()
    : undefined;
  const forwardedHost = config.TRUST_CODER_PROXY
    ? firstHeaderValue(request.headers['x-forwarded-host'])?.split(',')[0]?.trim()
    : undefined;
  const protocol = forwardedProtocol || request.protocol || 'http';
  const host = forwardedHost || firstHeaderValue(request.headers.host);
  return host ? normaliseOrigin(origin) === normaliseOrigin(`${protocol}://${host}`) : false;
}

function isAllowedOrigin(origin: string | undefined, request: FastifyRequest) {
  if (!origin) return true;
  const normalised = normaliseOrigin(origin);
  return Boolean(normalised && (allowedOrigins.has(normalised) || isSameOrigin(normalised, request)));
}

async function proxyKafkaUi(request: FastifyRequest, reply: any) {
  const sourcePath = (request.raw.url ?? '/').replace(/^\/kafka-ui-embed(?=\/|$)/, '') || '/';
  const target = new URL(sourcePath, config.KAFKA_UI_INTERNAL_URL);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined || ['host', 'content-length', 'accept-encoding', 'origin'].includes(key.toLowerCase()))
      continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set('accept-encoding', 'identity');
  const requestBody: BodyInit | undefined =
    request.body === undefined
      ? undefined
      : Buffer.isBuffer(request.body)
        ? new Uint8Array(request.body)
        : typeof request.body === 'string'
          ? request.body
          : JSON.stringify(request.body);
  const upstream = await fetch(target, { method: request.method, headers, body: requestBody });
  const contentType = upstream.headers.get('content-type') ?? '';
  const ignoredHeaders = new Set([
    'connection',
    'content-length',
    'content-security-policy',
    'transfer-encoding',
    'x-frame-options',
  ]);
  upstream.headers.forEach((value, key) => {
    if (!ignoredHeaders.has(key.toLowerCase())) reply.header(key, value);
  });
  let responseBody = Buffer.from(await upstream.arrayBuffer());
  if (contentType.includes('text/html')) {
    responseBody = Buffer.from(
      responseBody
        .toString('utf8')
        .replace("window.basePath = '';", "window.basePath = '/kafka-ui-embed';")
        .replace(/(href|src)="\//g, '$1="/kafka-ui-embed/')
    );
  }
  return reply.code(upstream.status).send(responseBody);
}

async function proxyInternalUi(request: FastifyRequest, reply: any, internalUrl: string) {
  const target = new URL(request.raw.url ?? '/', internalUrl);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined || ['host', 'content-length', 'accept-encoding', 'origin'].includes(key.toLowerCase()))
      continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set('accept-encoding', 'identity');
  const forwardedHost = firstHeaderValue(request.headers['x-forwarded-host']) || firstHeaderValue(request.headers.host);
  const forwardedProtocol = firstHeaderValue(request.headers['x-forwarded-proto']) || request.protocol || 'http';
  if (forwardedHost) headers.set('x-forwarded-host', forwardedHost);
  headers.set('x-forwarded-proto', forwardedProtocol);

  const requestBody: BodyInit | undefined =
    request.body === undefined
      ? undefined
      : Buffer.isBuffer(request.body)
        ? new Uint8Array(request.body)
        : typeof request.body === 'string'
          ? request.body
          : JSON.stringify(request.body);
  const upstream = await fetch(target, { method: request.method, headers, body: requestBody, redirect: 'manual' });
  const ignoredHeaders = new Set([
    'connection',
    'content-length',
    'content-security-policy',
    'set-cookie',
    'transfer-encoding',
    'x-frame-options',
  ]);
  upstream.headers.forEach((value, key) => {
    if (!ignoredHeaders.has(key.toLowerCase())) reply.header(key, value);
  });
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length) reply.header('set-cookie', cookies);
  return reply.code(upstream.status).send(Buffer.from(await upstream.arrayBuffer()));
}

await app.register(cors, {
  origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(normaliseOrigin(origin) ?? origin)),
  credentials: false,
});
const webDist = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../web/dist');
if (existsSync(webDist)) await app.register(fastifyStatic, { root: webDist, prefix: '/' });

app.addHook('onRequest', async (request, reply) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    const origin = request.headers.origin;
    if (!isAllowedOrigin(origin, request))
      return reply
        .code(403)
        .send({ type: 'error', code: 'ORIGIN_NOT_ALLOWED', message: 'Origin is not allowed', requestId: request.id });
  }
});

app.setErrorHandler((error: any, request, reply) => {
  request.log.error(error);
  const status =
    error.statusCode && error.statusCode < 500 ? error.statusCode : error.code === 'SERVICE_NOT_READY' ? 409 : 500;
  reply.code(status).send({
    type: 'error',
    code: error.code ?? 'INTERNAL_ERROR',
    message: error.message ?? 'Unexpected error',
    details: error.details ?? null,
    requestId: request.id,
  });
});

const actorFor = (request: any) =>
  config.TRUST_CODER_PROXY ? String(request.headers[config.CODER_ACTOR_HEADER] ?? 'local-user') : 'local-user';
registerJiraRoutes(app, database, config, actorFor);
const requireService = (id: string) => {
  const service = infra.getService(id);
  if (!service) throw Object.assign(new Error('Unknown service'), { statusCode: 404, code: 'SERVICE_NOT_FOUND' });
  return service;
};
const daemonOnly = (id: string) => {
  const service = requireService(id);
  if (service.runtimeMode !== 'daemon')
    throw Object.assign(new Error('Action is unavailable for one-off tools'), {
      statusCode: 400,
      code: 'ACTION_NOT_SUPPORTED',
    });
  return service;
};
const serviceParam = z.object({
  serviceId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
});

async function tracked<T>(request: any, serviceId: string, actionId: string, params: unknown, fn: () => Promise<T>) {
  const task = await tasks.create(serviceId, actionId, actorFor(request), request.id, params);
  const started = Date.now();
  await database.updateTask(task.id, { status: 'running', startedAt: new Date().toISOString() });
  await tasks.event(task.id, 'system', `Starting ${actionId}`);
  try {
    const result = await fn();
    await database.updateTask(task.id, {
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      exitCode: 0,
    });
    await tasks.event(task.id, 'system', `Completed ${actionId} in ${Date.now() - started}ms`);
    return { task, result };
  } catch (error: any) {
    await database.updateTask(task.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      errorCode: error.code ?? 'OPERATION_FAILED',
      errorMessage: error.message,
    });
    await tasks.event(task.id, 'stderr', error.message);
    throw error;
  }
}

function sse(reply: any) {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (event: string, data: unknown, id?: number) => {
    if (id) reply.raw.write(`id: ${id}\n`);
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
  reply.raw.on('close', () => clearInterval(ping));
  return {
    send,
    close: () => {
      clearInterval(ping);
      reply.raw.end();
    },
  };
}

app.get('/api/health', async () => ({ ok: true, requestId: undefined }));
app.get('/api/overview', async () => infra.overview());
app.get('/api/system', async () => (await infra.overview()).system);
app.get('/api/services', async () => infra.allServices());
app.get('/api/services/:serviceId', async (request) =>
  infra.serviceStatus(requireService(serviceParam.parse(request.params).serviceId))
);

for (const action of ['start', 'stop', 'restart'] as const) {
  app.post(`/api/services/:serviceId/${action}`, async (request) => {
    const service = daemonOnly(serviceParam.parse(request.params).serviceId);
    const task = await tasks.create(service.id, `compose.${action}Service`, actorFor(request), request.id, {
      service: service.id,
    });
    await tasks.run(task, 'docker', infra.composeArgs(action === 'start' ? 'up' : action, [service.compose!]));
    return { type: 'task', taskId: task.id, status: 'running', eventUrl: `/api/tasks/${task.id}/events` };
  });
}

app.post('/api/tasks', async (request) => {
  const body = z
    .object({
      actionId: z.enum(['compose.startAll', 'compose.stopAll', 'compose.restartUnhealthy']),
      params: z.object({}).passthrough().default({}),
    })
    .parse(request.body);
  const names = infra.daemonServices.map((service) => service.compose!);
  if (body.actionId === 'compose.restartUnhealthy') {
    const states = await infra.allServices();
    const unhealthy = states.filter((state: any) => state.status === 'unhealthy').map((state: any) => state.compose);
    const task = await tasks.create('kafka', body.actionId, actorFor(request), request.id, body.params);
    await tasks.run(task, 'docker', infra.composeArgs('restart', unhealthy));
    return { type: 'task', taskId: task.id, status: 'running', eventUrl: `/api/tasks/${task.id}/events` };
  }
  const task = await tasks.create('mysql', body.actionId, actorFor(request), request.id, body.params);
  await tasks.run(task, 'docker', infra.composeArgs(body.actionId === 'compose.startAll' ? 'up' : 'stop', names));
  return { type: 'task', taskId: task.id, status: 'running', eventUrl: `/api/tasks/${task.id}/events` };
});

app.get('/api/services/:serviceId/logs/events', async (request, reply) => {
  const service = daemonOnly(serviceParam.parse(request.params).serviceId);
  const { tail } = z.object({ tail: z.coerce.number().int().min(1).max(1000).default(100) }).parse(request.query);
  const channel = sse(reply);
  try {
    const stream = await infra.streamContainerLogs(service, tail, (streamName, text) =>
      channel.send('log', { timestamp: new Date().toISOString(), stream: streamName, text })
    );
    request.raw.on('close', () => (stream as any).destroy?.());
  } catch (error: any) {
    channel.send('error', { code: 'LOG_STREAM_FAILED', message: error.message });
    channel.close();
  }
});

app.get('/api/tasks/history', async (request) => {
  const query = z
    .object({
      limit: z.coerce.number().int().min(1).max(200).default(100),
      offset: z.coerce.number().int().min(0).default(0),
      service: z.string().optional(),
      status: z.string().optional(),
      q: z.string().trim().max(160).optional(),
    })
    .parse(request.query);
  return { rows: await database.listTasks(query.limit, query.offset, query), limit: query.limit, offset: query.offset };
});
app.delete('/api/tasks', async (request) => {
  const { taskIds } = z.object({ taskIds: z.array(z.string().min(1)).min(1).max(100) }).parse(request.body);
  const deleted = await database.deleteTasks(taskIds);
  return { deleted, skipped: taskIds.length - deleted };
});
app.get('/api/tasks/:taskId', async (request) => {
  const task = await database.getTask(z.object({ taskId: z.string() }).parse(request.params).taskId);
  if (!task) throw Object.assign(new Error('Task not found'), { statusCode: 404, code: 'TASK_NOT_FOUND' });
  return task;
});
app.post('/api/tasks/:taskId/cancel', async (request) => ({
  cancelled: tasks.cancel(z.object({ taskId: z.string() }).parse(request.params).taskId),
}));
app.get('/api/tasks/:taskId/events', async (request, reply) => {
  const taskId = z.object({ taskId: z.string() }).parse(request.params).taskId;
  const after = Number(request.headers['last-event-id'] ?? 0);
  const channel = sse(reply);
  (await database.getEvents(taskId, after)).forEach((event) => channel.send('log', event, event.id));
  const listener = (event: any) => channel.send('log', event, event.id);
  tasks.events.on(`task:${taskId}`, listener);
  request.raw.on('close', () => tasks.events.off(`task:${taskId}`, listener));
});

const managedServiceBody = z.object({
  name: z.string().trim().min(1).max(100),
  runtime: z.enum(['go', 'node', 'vue']),
  workingDir: z.string().trim().min(1).max(300),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(10_000)).default({}),
});
const managedServiceId = z.object({ serviceId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/) });

app.get('/api/app-services', async () => ({ rows: await managedServices.list() }));
app.post('/api/app-services', async (request) => {
  const body = managedServiceBody.parse(request.body);
  const now = new Date().toISOString();
  const service = await database.saveManagedService({
    id: `app-${randomUUID().slice(0, 8)}`,
    ...body,
    createdAt: now,
    updatedAt: now,
  });
  return managedServices.status(service);
});
app.put('/api/app-services/:serviceId', async (request) => {
  const { serviceId } = managedServiceId.parse(request.params);
  const current = await database.getManagedService(serviceId);
  if (!current) throw Object.assign(new Error('Managed service not found'), { statusCode: 404 });
  const body = managedServiceBody.parse(request.body);
  const service = await database.saveManagedService({ ...current, ...body, updatedAt: new Date().toISOString() });
  return managedServices.status(service);
});
app.delete('/api/app-services/:serviceId', async (request) => {
  const { serviceId } = managedServiceId.parse(request.params);
  await managedServices.stop(serviceId);
  if (!(await database.deleteManagedService(serviceId)))
    throw Object.assign(new Error('Managed service not found'), { statusCode: 404 });
  return { deleted: true };
});
for (const action of ['start', 'stop', 'restart'] as const) {
  app.post(`/api/app-services/:serviceId/${action}`, async (request) => {
    const { serviceId } = managedServiceId.parse(request.params);
    return await managedServices[action](serviceId);
  });
}
app.get('/api/app-services/:serviceId/logs/events', async (request, reply) => {
  const { serviceId } = managedServiceId.parse(request.params);
  if (!(await managedServices.get(serviceId)))
    throw Object.assign(new Error('Managed service not found'), { statusCode: 404 });
  const { tail } = z.object({ tail: z.coerce.number().int().min(1).max(1000).default(100) }).parse(request.query);
  const channel = sse(reply);
  (await managedServices.eventsFor(serviceId, tail)).forEach((event) => channel.send('log', event, event.id));
  const listener = (event: any) => channel.send('log', event, event.id);
  managedServices.events.on(`service:${serviceId}`, listener);
  request.raw.on('close', () => managedServices.events.off(`service:${serviceId}`, listener));
});

const dockerCommands = [
  { id: 'containers', label: 'List containers', command: 'docker', args: ['ps', '-a'] },
  { id: 'images', label: 'List images', command: 'docker', args: ['images'] },
  { id: 'networks', label: 'List networks', command: 'docker', args: ['network', 'ls'] },
  { id: 'volumes', label: 'List volumes', command: 'docker', args: ['volume', 'ls'] },
  { id: 'compose-ps', label: 'Compose service status', command: 'docker', args: infra.composeReadArgs(['ps']) },
  {
    id: 'compose-services',
    label: 'Compose service list',
    command: 'docker',
    args: infra.composeReadArgs(['config', '--services']),
  },
] as const;
app.get('/api/docker/commands', async () => dockerCommands.map(({ id, label }) => ({ id, label })));
app.post('/api/docker/tasks', async (request) => {
  const { commandId } = z
    .object({ commandId: z.enum(['containers', 'images', 'networks', 'volumes', 'compose-ps', 'compose-services']) })
    .parse(request.body);
  const command = dockerCommands.find((item) => item.id === commandId)!;
  const task = await tasks.create('docker', `docker.${commandId}`, actorFor(request), request.id, { commandId });
  await tasks.run(task, command.command, [...command.args]);
  return { type: 'task', taskId: task.id, status: 'running', eventUrl: `/api/tasks/${task.id}/events` };
});

app.get(
  '/api/mysql/databases',
  async (request) => (await tracked(request, 'mysql', 'mysql.databases', {}, () => infra.mysqlDatabases())).result
);
app.get('/api/mysql/databases/:database/tables', async (request) => {
  const { database } = z.object({ database: z.string() }).parse(request.params);
  return (await tracked(request, 'mysql', 'mysql.tables', { database }, () => infra.mysqlTables(database))).result;
});
app.get('/api/mysql/databases/:database/tables/:table/schema', async (request) => {
  const params = z.object({ database: z.string(), table: z.string() }).parse(request.params);
  return (
    await tracked(request, 'mysql', 'mysql.schema', params, () => infra.mysqlSchema(params.database, params.table))
  ).result;
});
app.get('/api/mysql/databases/:database/tables/:table/rows', async (request) => {
  const params = z.object({ database: z.string(), table: z.string() }).parse(request.params);
  const query = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(1000).default(100),
    })
    .parse(request.query);
  return (
    await tracked(request, 'mysql', 'mysql.rows', { ...params, ...query }, () =>
      infra.mysqlRows(params.database, params.table, query.page, query.pageSize)
    )
  ).result;
});
app.post('/api/mysql/query', async (request) => {
  const body = z.object({ sql: z.string().min(1).max(100_000) }).parse(request.body);
  return (await tracked(request, 'mysql', 'mysql.runReadQuery', { sql: body.sql }, () => infra.mysqlQuery(body.sql)))
    .result;
});

const gcloudActions = [
  { id: 'version', label: 'Show SDK version', args: ['--version'] },
  { id: 'config-list', label: 'List active configuration', args: ['config', 'list', '--format=json'] },
  { id: 'configurations', label: 'List configurations', args: ['config', 'configurations', 'list', '--format=json'] },
  { id: 'auth-list', label: 'List authenticated accounts', args: ['auth', 'list', '--format=json'] },
];
app.get('/api/gcloud/actions', async () => gcloudActions.map(({ id, label }) => ({ id, label })));
app.post('/api/gcloud/tasks', async (request) => {
  const body = z
    .object({
      actionId: z.enum(['version', 'config-list', 'configurations', 'auth-list']),
      project: z.string().max(120).optional(),
    })
    .parse(request.body);
  const action = gcloudActions.find((item) => item.id === body.actionId)!;
  const task = await tasks.create('gcloud', 'gcloud.runApprovedAction', actorFor(request), request.id, body);
  const args = [...action.args, ...(body.project ? ['--project', body.project] : [])];
  await tasks.run(task, 'docker', infra.gcloudArgs(args, `local-infra-task-${task.id}`));
  return { type: 'task', taskId: task.id, status: 'running', eventUrl: `/api/tasks/${task.id}/events` };
});
app.get('/api/gcloud/configurations', async () => ({ action: 'configurations' }));
app.get('/api/gcloud/accounts', async () => ({ action: 'auth-list' }));

app.get(
  '/api/datastore/namespaces',
  async (request) =>
    (await tracked(request, 'datastore', 'datastore.namespaces', {}, () => infra.datastoreNamespaces())).result
);
app.get('/api/datastore/kinds', async (request) => {
  const query = z.object({ namespace: z.string().optional() }).parse(request.query);
  return (await tracked(request, 'datastore', 'datastore.kinds', query, () => infra.datastoreKinds(query.namespace)))
    .result;
});
app.post('/api/datastore/query', async (request) => {
  const body = z
    .object({
      kind: z.string().min(1),
      namespace: z.string().optional(),
      filter: z
        .object({ property: z.string(), operator: z.enum(['=', '>', '>=', '<', '<=']), value: z.string() })
        .optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      cursor: z.string().optional(),
    })
    .parse(request.body);
  return (await tracked(request, 'datastore', 'datastore.runQuery', body, () => infra.datastoreQuery(body))).result;
});
app.get('/api/datastore/entities/:encodedKey', async (request) => ({
  entity: await infra.datastoreEntity(z.object({ encodedKey: z.string() }).parse(request.params).encodedKey),
}));

app.get(
  '/api/kafka/cluster',
  async (request) => (await tracked(request, 'kafka', 'kafka.cluster', {}, () => infra.kafkaCluster())).result
);
app.get(
  '/api/kafka/topics',
  async (request) => (await tracked(request, 'kafka', 'kafka.topics', {}, () => infra.kafkaTopics())).result
);
app.post('/api/kafka/topics', async (request) => {
  const body = z
    .object({
      name: z.string().regex(/^[a-zA-Z0-9._-]{1,249}$/),
      partitions: z.number().int().min(1).max(24),
      replicationFactor: z.literal(1),
    })
    .parse(request.body);
  return (
    await tracked(request, 'kafka', 'kafka.createTopic', body, () =>
      infra.kafkaCreateTopic(body.name, body.partitions, body.replicationFactor)
    )
  ).result;
});
app.delete('/api/kafka/topics/:topic', async (request) => {
  const { topic } = z.object({ topic: z.string() }).parse(request.params);
  const { confirmation } = z.object({ confirmation: z.string() }).parse(request.body);
  if (confirmation !== topic)
    throw Object.assign(new Error('Topic confirmation does not match'), {
      statusCode: 400,
      code: 'CONFIRMATION_REQUIRED',
    });
  return (await tracked(request, 'kafka', 'kafka.deleteTopic', { topic }, () => infra.kafkaDeleteTopic(topic))).result;
});
app.get('/api/kafka/topics/:topic/partitions', async (request) => {
  const { topic } = z.object({ topic: z.string() }).parse(request.params);
  return (await tracked(request, 'kafka', 'kafka.partitions', { topic }, () => infra.kafkaPartitions(topic))).result;
});
app.post('/api/kafka/messages', async (request) => {
  const body = z
    .object({
      topic: z.string().min(1),
      key: z.string().optional(),
      value: z.string().max(1_000_000),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .parse(request.body);
  return (await tracked(request, 'kafka', 'kafka.produceMessage', body, () => infra.kafkaProduce(body))).result;
});
app.post('/api/kafka/consume', async (request) => {
  const body = z
    .object({
      topic: z.string().min(1),
      partition: z.number().int().min(0).optional(),
      offsetMode: z.enum(['earliest', 'latest']).default('latest'),
      limit: z.number().int().min(1).max(500).default(50),
    })
    .parse(request.body);
  return (await tracked(request, 'kafka', 'kafka.consume', body, () => infra.kafkaConsume(body))).result;
});
app.get(
  '/api/kafka/consumer-groups',
  async (request) => (await tracked(request, 'kafka', 'kafka.consumerGroups', {}, () => infra.kafkaGroups())).result
);

app.get(
  '/api/kafka-ui/status',
  async (request) => (await tracked(request, 'kafka-ui', 'kafka-ui.status', {}, () => infra.kafkaUiStatus())).result
);
app.get('/api/kafka-ui/open-url', async () => ({ url: config.KAFKA_UI_OPEN_URL || null }));
app.route({
  method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  url: '/kafka-ui-embed/*',
  handler: proxyKafkaUi,
});
app.get(
  '/api/keycloak/status',
  async (request) => (await tracked(request, 'keycloak', 'keycloak.status', {}, () => infra.keycloakStatus())).result
);
app.get('/api/keycloak/open-url', async () => ({
  url: config.KEYCLOAK_OPEN_URL || '/keycloak-embed/admin/master/console/',
}));
app.get(
  '/api/mailhog/status',
  async (request) => (await tracked(request, 'mailhog', 'mailhog.status', {}, () => infra.mailhogStatus())).result
);
app.get('/api/mailhog/open-url', async () => ({ url: config.MAILHOG_OPEN_URL || '/mailhog-embed/' }));
for (const url of ['/keycloak-embed', '/keycloak-embed/*']) {
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url,
    handler: (request, reply) => proxyInternalUi(request, reply, config.KEYCLOAK_INTERNAL_URL),
  });
}
for (const url of ['/mailhog-embed', '/mailhog-embed/*']) {
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url,
    handler: (request, reply) => proxyInternalUi(request, reply, config.MAILHOG_INTERNAL_URL),
  });
}
app.get(
  '/api/bigquery/status',
  async (request) => (await tracked(request, 'bigquery', 'bigquery.status', {}, () => infra.bigQueryStatus())).result
);
app.get(
  '/api/bigquery/datasets',
  async (request) =>
    (await tracked(request, 'bigquery', 'bigquery.datasets', {}, () => infra.bigQueryDatasets())).result
);
app.get('/api/bigquery/datasets/:dataset/tables', async (request) => {
  const { dataset } = z.object({ dataset: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,1023}$/) }).parse(request.params);
  return (await tracked(request, 'bigquery', 'bigquery.tables', { dataset }, () => infra.bigQueryTables(dataset)))
    .result;
});
app.post('/api/bigquery/query', async (request) => {
  const body = z.object({ sql: z.string().min(1).max(100_000) }).parse(request.body);
  return (
    await tracked(request, 'bigquery', 'bigquery.runReadQuery', { sql: body.sql }, () => infra.bigQueryQuery(body.sql))
  ).result;
});
app.get(
  '/api/redash/status',
  async (request) => (await tracked(request, 'redash', 'redash.status', {}, () => infra.redashStatus())).result
);
app.get('/api/redash/open-url', async () => ({ url: config.REDASH_OPEN_URL || 'http://localhost:5000' }));

app.get(
  '/api/spanner/instances',
  async (request) => (await tracked(request, 'spanner', 'spanner.instances', {}, () => infra.spannerInstances())).result
);
app.post('/api/spanner/instances', async (request) => {
  const body = z.object({ instanceId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/) }).parse(request.body);
  return (
    await tracked(request, 'spanner', 'spanner.createInstance', body, () =>
      infra.spannerCreateInstance(body.instanceId)
    )
  ).result;
});
app.get('/api/spanner/instances/:instance/databases', async (request) => {
  const { instance } = z.object({ instance: z.string() }).parse(request.params);
  return (await tracked(request, 'spanner', 'spanner.databases', { instance }, () => infra.spannerDatabases(instance)))
    .result;
});
app.post('/api/spanner/instances/:instance/databases', async (request) => {
  const { instance } = z.object({ instance: z.string() }).parse(request.params);
  const { databaseId } = z
    .object({ databaseId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,62}$/) })
    .parse(request.body);
  return (
    await tracked(request, 'spanner', 'spanner.createDatabase', { instance, databaseId }, () =>
      infra.spannerCreateDatabase(instance, databaseId)
    )
  ).result;
});
app.get('/api/spanner/databases/:database/tables', async (request) => {
  const { database } = z.object({ database: z.string() }).parse(request.params);
  const instance = String((request.query as any).instance ?? config.SPANNER_INSTANCE_ID);
  return (
    await tracked(request, 'spanner', 'spanner.tables', { instance, database }, () =>
      infra.spannerTables(instance, database)
    )
  ).result;
});
app.get('/api/spanner/databases/:database/tables/:table/schema', async (request) => {
  const params = z.object({ database: z.string(), table: z.string() }).parse(request.params);
  const instance = String((request.query as any).instance ?? config.SPANNER_INSTANCE_ID);
  return (
    await tracked(request, 'spanner', 'spanner.schema', { instance, ...params }, () =>
      infra.spannerSchema(instance, params.database, params.table)
    )
  ).result;
});
app.get('/api/spanner/databases/:database/tables/:table/rows', async (request) => {
  const params = z.object({ database: z.string(), table: z.string() }).parse(request.params);
  const instance = String((request.query as any).instance ?? config.SPANNER_INSTANCE_ID);
  return (
    await tracked(request, 'spanner', 'spanner.rows', { instance, ...params }, () =>
      infra.spannerQuery(instance, params.database, `SELECT * FROM ${params.table} LIMIT 100`)
    )
  ).result;
});
app.post('/api/spanner/query', async (request) => {
  const body = z
    .object({ instanceId: z.string(), databaseId: z.string(), sql: z.string().min(1).max(100_000) })
    .parse(request.body);
  return (
    await tracked(request, 'spanner', 'spanner.runReadQuery', body, () =>
      infra.spannerQuery(body.instanceId, body.databaseId, body.sql)
    )
  ).result;
});
const savedSpannerQuery = z.object({
  name: z.string().trim().min(1).max(100),
  instanceId: z.string().min(1),
  databaseId: z.string().min(1),
  sql: z.string().trim().min(1).max(100_000),
});
app.get('/api/spanner/saved-queries', async (request) => {
  const { instanceId, databaseId } = z
    .object({ instanceId: z.string().min(1), databaseId: z.string().min(1) })
    .parse(request.query);
  return { rows: await database.listSavedSpannerQueries(instanceId, databaseId) };
});
app.post('/api/spanner/saved-queries', async (request) => {
  const body = savedSpannerQuery.parse(request.body);
  const now = new Date().toISOString();
  return await database.saveSpannerQuery({
    id: `spanner-query-${randomUUID()}`,
    ...body,
    createdAt: now,
    updatedAt: now,
  });
});
app.delete('/api/spanner/saved-queries/:queryId', async (request) => {
  const { queryId } = z.object({ queryId: z.string().min(1) }).parse(request.params);
  if (!(await database.deleteSavedSpannerQuery(queryId)))
    throw Object.assign(new Error('Saved query not found'), { statusCode: 404, code: 'SAVED_QUERY_NOT_FOUND' });
  return { deleted: true };
});

if (existsSync(webDist))
  app.setNotFoundHandler((request, reply) =>
    request.raw.url?.startsWith('/api/')
      ? reply.code(404).send({ type: 'error', code: 'NOT_FOUND', message: 'Not found', requestId: request.id })
      : reply.sendFile('index.html')
  );

await app.listen({ port: config.PORT, host: config.HOST });
