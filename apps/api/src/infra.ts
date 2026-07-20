import os from 'node:os';
import { spawn } from 'node:child_process';
import Docker from 'dockerode';
import mysql from 'mysql2/promise';
import { Datastore } from '@google-cloud/datastore';
import { Kafka, logLevel } from 'kafkajs';
import { MutationSet, Spanner } from '@google-cloud/spanner';
import { z } from 'zod';
import { config, type Config } from './config.js';

export type ServiceDefinition = {
  id: string;
  label: string;
  container?: string;
  compose?: string;
  image: string;
  ports: string[];
  runtimeMode: 'daemon' | 'one_off';
};

export const defaultServices: ServiceDefinition[] = [
  {
    id: 'mysql',
    label: 'MySQL',
    compose: 'mysql',
    container: 'mysql-share',
    image: 'mysql:5.7',
    ports: ['3306'],
    runtimeMode: 'daemon',
  },
  {
    id: 'gcloud',
    label: 'gcloud CLI',
    compose: 'gcloud',
    image: 'google-cloud-cli:stable',
    ports: [],
    runtimeMode: 'one_off',
  },
  {
    id: 'datastore',
    label: 'Datastore',
    compose: 'datastore',
    container: 'datastore',
    image: 'cloud-sdk:emulators',
    ports: ['8085'],
    runtimeMode: 'daemon',
  },
  {
    id: 'kafka',
    label: 'Kafka',
    compose: 'kafka',
    container: 'local-kafka',
    image: 'apache/kafka:3.9.0',
    ports: ['9094'],
    runtimeMode: 'daemon',
  },
  {
    id: 'kafka-ui',
    label: 'Kafka UI',
    compose: 'kafka-ui',
    container: 'local-kafka-ui',
    image: 'provectuslabs/kafka-ui:latest',
    ports: ['8080'],
    runtimeMode: 'daemon',
  },
  {
    id: 'redash',
    label: 'Redash',
    compose: 'redash',
    container: 'local-redash',
    image: 'redash/redash:10.1.0.b50633',
    ports: ['5000'],
    runtimeMode: 'daemon',
  },
  {
    id: 'spanner',
    label: 'Spanner',
    compose: 'spanner',
    container: 'local-spanner',
    image: 'cloud-spanner-emulator:latest',
    ports: ['9010', '9020'],
    runtimeMode: 'daemon',
  },
];

const serviceCatalogSchema = z.array(
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    label: z.string().trim().min(1).max(80),
    compose: z.string().trim().min(1).max(120),
    container: z.string().trim().min(1).max(160).optional(),
    image: z.string().trim().min(1).max(200).default('Docker Compose service'),
    ports: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    runtimeMode: z.enum(['daemon', 'one_off']).default('daemon'),
  })
);

const serviceCatalogFor = (value: string): ServiceDefinition[] => {
  if (!value.trim()) return defaultServices;
  try {
    return serviceCatalogSchema.parse(JSON.parse(value));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Invalid JSON';
    throw new Error(`CONTROL_CENTER_SERVICES must be a valid JSON service array: ${message}`);
  }
};

export type TableResult = {
  type: 'table';
  columns: { key: string; label: string; dataType: string }[];
  rows: Record<string, unknown>[];
  metadata: { rowCount: number; durationMs: number; nextCursor: string | null };
};
export const table = (
  rows: Record<string, unknown>[],
  durationMs = 0,
  nextCursor: string | null = null
): TableResult => ({
  type: 'table',
  columns: Object.keys(rows[0] ?? {}).map((key) => ({
    key,
    label: key,
    dataType: typeof rows[0]?.[key],
  })),
  rows,
  metadata: { rowCount: rows.length, durationMs, nextCursor },
});

const allowedReadStatement = (sql: string, allowed: string[]) => {
  const normalized = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .trim();
  if (!normalized || normalized.split(';').filter((part) => part.trim()).length !== 1)
    throw Object.assign(new Error('Only one SQL statement is allowed'), {
      code: 'INVALID_SQL',
    });
  const first = normalized.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
  if (!first || !allowed.includes(first))
    throw Object.assign(new Error(`Only ${allowed.join(', ')} statements are allowed`), { code: 'READ_ONLY_SQL' });
  return normalized.replace(/;\s*$/, '');
};

const identifier = (value: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value))
    throw Object.assign(new Error('Invalid identifier'), {
      code: 'INVALID_IDENTIFIER',
    });
  return `\`${value}\``;
};

export class Infrastructure {
  readonly docker = new Docker(process.env.DOCKER_HOST ? { host: process.env.DOCKER_HOST } : undefined);
  readonly services: ServiceDefinition[];
  private mysqlPool?: mysql.Pool;
  private datastore?: Datastore;
  private kafka?: Kafka;
  private spanner?: Spanner;
  private spannerSeed?: Promise<void>;

  constructor(private readonly env: Config = config) {
    this.services = serviceCatalogFor(env.CONTROL_CENTER_SERVICES);
  }

  getService(id: string) {
    return this.services.find((service) => service.id === id);
  }

  get daemonServices() {
    return this.services.filter((service) => service.runtimeMode === 'daemon');
  }

  composeArgs(action: 'up' | 'stop' | 'restart', names: string[]) {
    const base = ['compose', '--project-name', this.env.COMPOSE_PROJECT_NAME, '--file', this.env.COMPOSE_FILE];
    if (action === 'up') return [...base, 'up', '-d', ...names];
    return [...base, action, ...names];
  }

  composeReadArgs(args: string[]) {
    return ['compose', '--project-name', this.env.COMPOSE_PROJECT_NAME, '--file', this.env.COMPOSE_FILE, ...args];
  }

  gcloudArgs(args: string[], taskName: string) {
    return [
      'compose',
      '--project-name',
      this.env.COMPOSE_PROJECT_NAME,
      '--file',
      this.env.COMPOSE_FILE,
      '--profile',
      'tools',
      'run',
      '--rm',
      '--name',
      taskName,
      'gcloud',
      ...args,
    ];
  }

  private async containerFor(service: ServiceDefinition) {
    if (service.container) return this.docker.getContainer(service.container);
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: [
          `com.docker.compose.project=${this.env.COMPOSE_PROJECT_NAME}`,
          `com.docker.compose.service=${service.compose}`,
        ],
      },
    });
    if (!containers[0]?.Id) {
      const error = Object.assign(new Error('Compose container has not been created'), { statusCode: 404 });
      throw error;
    }
    return this.docker.getContainer(containers[0].Id);
  }

  async serviceStatus(service: ServiceDefinition) {
    if (service.runtimeMode === 'one_off')
      return {
        ...service,
        status: 'not_created',
        availability: 'ready',
        health: null,
        uptime: null,
      };
    try {
      const inspect = await (await this.containerFor(service)).inspect();
      const state = inspect.State;
      const health = state.Health?.Status ?? null;
      const status =
        health === 'healthy'
          ? 'healthy'
          : health === 'unhealthy'
            ? 'unhealthy'
            : state.Running
              ? health === 'starting'
                ? 'starting'
                : 'running'
              : state.Status === 'created'
                ? 'not_created'
                : 'stopped';
      return {
        ...service,
        status,
        health,
        uptime: state.StartedAt,
        containerState: state.Status,
        error: state.Error || null,
      };
    } catch (error: any) {
      if (error.statusCode === 404)
        return {
          ...service,
          status: 'not_created',
          health: null,
          uptime: null,
          containerState: 'missing',
        };
      return {
        ...service,
        status: 'unknown',
        health: null,
        uptime: null,
        containerState: 'unknown',
        error: error.message,
      };
    }
  }

  async allServices() {
    return Promise.all(this.services.map((service) => this.serviceStatus(service)));
  }

  async overview() {
    const [serviceList, dockerDf] = await Promise.all([this.allServices(), this.docker.df().catch(() => null)]);
    const memory = process.memoryUsage();
    const totalMem = os.totalmem();
    const running = serviceList.filter((service: any) =>
      ['running', 'healthy', 'starting'].includes(service.status)
    ).length;
    const unhealthy = serviceList.filter((service: any) => service.status === 'unhealthy').length;
    const stopped = serviceList.filter(
      (service: any) => ['stopped', 'not_created'].includes(service.status) && service.runtimeMode === 'daemon'
    ).length;
    return {
      system: {
        cpuCores: os.availableParallelism(),
        memory: {
          total: totalMem,
          used: totalMem - os.freemem(),
          available: os.freemem(),
          processRss: memory.rss,
        },
        disk: null,
        docker: dockerDf,
        uptimeSeconds: os.uptime(),
      },
      services: serviceList,
      counts: {
        running,
        unhealthy,
        stopped,
        totalDaemons: this.daemonServices.length,
      },
    };
  }

  private getMysql() {
    return (this.mysqlPool ??= mysql.createPool({
      host: this.env.MYSQL_HOST,
      port: this.env.MYSQL_PORT,
      user: this.env.MYSQL_USER,
      password: this.env.MYSQL_PASSWORD,
      database: this.env.MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 5,
      multipleStatements: false,
    }));
  }

  async mysqlDatabases() {
    const start = Date.now();
    const [rows] = await this.getMysql().query<any[]>('SHOW DATABASES');
    return table(
      rows
        .filter((row) => !['information_schema', 'mysql', 'performance_schema', 'sys'].includes(row.Database))
        .map((row) => ({ name: row.Database })),
      Date.now() - start
    );
  }
  async mysqlTables(database: string) {
    const start = Date.now();
    const [rows] = await this.getMysql().query<any[]>(`SHOW TABLE STATUS FROM ${identifier(database)}`);
    return table(
      rows.map((row) => ({
        name: row.Name,
        rows: row.Rows,
        engine: row.Engine,
        comment: row.Comment,
      })),
      Date.now() - start
    );
  }
  async mysqlSchema(database: string, name: string) {
    const start = Date.now();
    const [rows] = await this.getMysql().query<any[]>(`DESCRIBE ${identifier(database)}.${identifier(name)}`);
    return table(
      rows.map((row) => ({
        field: row.Field,
        type: row.Type,
        nullable: row.Null,
        key: row.Key,
        defaultValue: row.Default,
      })),
      Date.now() - start
    );
  }
  async mysqlRows(database: string, name: string, page: number, pageSize: number) {
    const start = Date.now();
    const safePageSize = Math.min(Math.max(pageSize, 1), 1000);
    const offset = Math.max(page - 1, 0) * safePageSize;
    const [rows] = await this.getMysql().query<any[]>(
      `SELECT * FROM ${identifier(database)}.${identifier(name)} LIMIT ? OFFSET ?`,
      [safePageSize, offset]
    );
    return table(
      rows,
      Date.now() - start,
      rows.length === safePageSize ? Buffer.from(String(page + 1)).toString('base64url') : null
    );
  }
  async mysqlQuery(sql: string) {
    const start = Date.now();
    const safeSql = allowedReadStatement(sql, ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN']);
    const [rows] = await this.getMysql().query<any[]>(safeSql);
    return {
      ...table(Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [], Date.now() - start),
      sql: safeSql,
    };
  }

  private getDatastore() {
    return (this.datastore ??= new Datastore({
      projectId: this.env.DATASTORE_PROJECT_ID,
      apiEndpoint: this.env.DATASTORE_EMULATOR_HOST,
    }));
  }
  async datastoreNamespaces() {
    const start = Date.now();
    const datastore = this.getDatastore();
    const [entities] = await datastore.runQuery(datastore.createQuery('__namespace__'));
    return table(
      entities.map((entity: any) => ({
        namespace: entity[datastore.KEY]?.name ?? '(default)',
      })),
      Date.now() - start
    );
  }
  async datastoreKinds(namespace?: string) {
    const start = Date.now();
    const datastore = this.getDatastore();
    const query =
      namespace && namespace !== 'default'
        ? datastore.createQuery(namespace, '__kind__')
        : datastore.createQuery('__kind__');
    const [entities] = await datastore.runQuery(query);
    return table(
      entities.map((entity: any) => ({ name: entity[datastore.KEY]?.name })),
      Date.now() - start
    );
  }
  async datastoreQuery(input: {
    kind: string;
    namespace?: string;
    filter?: { property: string; operator: string; value: string };
    limit?: number;
    cursor?: string;
  }) {
    const start = Date.now();
    const datastore = this.getDatastore();
    const query = (
      input.namespace && input.namespace !== 'default'
        ? datastore.createQuery(input.namespace, input.kind)
        : datastore.createQuery(input.kind)
    ).limit(Math.min(input.limit ?? 100, 1000));
    if (input.filter?.property && input.filter.value !== '')
      query.filter(input.filter.property, input.filter.operator as any, input.filter.value);
    if (input.cursor) query.start(Buffer.from(input.cursor, 'base64url').toString());
    const [entities, info] = await datastore.runQuery(query);
    const rows = entities.map((entity: any) => ({
      key: Buffer.from(JSON.stringify(entity[datastore.KEY])).toString('base64url'),
      ...entity,
    }));
    return table(rows, Date.now() - start, info?.endCursor ? Buffer.from(info.endCursor).toString('base64url') : null);
  }
  async datastoreEntity(encoded: string) {
    const datastore = this.getDatastore();
    const key = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    const [entity] = await datastore.get(key);
    return entity ?? null;
  }

  private getKafka() {
    return (this.kafka ??= new Kafka({
      clientId: 'local-infra-control-center',
      brokers: this.env.KAFKA_BOOTSTRAP_SERVERS.split(','),
      logLevel: logLevel.NOTHING,
    }));
  }
  async kafkaCluster() {
    const admin = this.getKafka().admin();
    await admin.connect();
    try {
      return await admin.describeCluster();
    } finally {
      await admin.disconnect();
    }
  }
  async kafkaTopics() {
    const start = Date.now();
    const admin = this.getKafka().admin();
    await admin.connect();
    try {
      const topics = await admin.listTopics();
      const metadata = topics.length ? await admin.fetchTopicMetadata({ topics }) : { topics: [] };
      return table(
        metadata.topics.map((topic) => ({
          name: topic.name,
          partitions: topic.partitions.length,
          replication: topic.partitions[0]?.replicas?.length ?? 0,
        })),
        Date.now() - start
      );
    } finally {
      await admin.disconnect();
    }
  }
  async kafkaPartitions(topic: string) {
    const admin = this.getKafka().admin();
    await admin.connect();
    try {
      const [metadata, offsets] = await Promise.all([
        admin.fetchTopicMetadata({ topics: [topic] }),
        admin.fetchTopicOffsets(topic),
      ]);
      const endByPartition = new Map(offsets.map((offset) => [offset.partition, offset.high]));
      return table(
        metadata.topics[0]?.partitions.map((partition) => ({
          partition: partition.partitionId,
          leader: partition.leader,
          replicas: partition.replicas.join(','),
          endOffset: endByPartition.get(partition.partitionId) ?? null,
        })) ?? []
      );
    } finally {
      await admin.disconnect();
    }
  }
  async kafkaCreateTopic(name: string, partitions: number, replicationFactor: number) {
    const admin = this.getKafka().admin();
    await admin.connect();
    try {
      return await admin.createTopics({
        topics: [{ topic: name, numPartitions: partitions, replicationFactor }],
      });
    } finally {
      await admin.disconnect();
    }
  }
  async kafkaDeleteTopic(name: string) {
    const admin = this.getKafka().admin();
    await admin.connect();
    try {
      return await admin.deleteTopics({ topics: [name] });
    } finally {
      await admin.disconnect();
    }
  }
  async kafkaProduce(input: { topic: string; key?: string; value: string; headers?: Record<string, string> }) {
    const producer = this.getKafka().producer();
    await producer.connect();
    try {
      return await producer.send({
        topic: input.topic,
        messages: [{ key: input.key, value: input.value, headers: input.headers }],
      });
    } finally {
      await producer.disconnect();
    }
  }
  async kafkaConsume(input: { topic: string; partition?: number; offsetMode: 'earliest' | 'latest'; limit: number }) {
    const consumer = this.getKafka().consumer({
      groupId: `local-infra-viewer-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    });
    const messages: Record<string, unknown>[] = [];
    await consumer.connect();
    try {
      await consumer.subscribe({
        topic: input.topic,
        fromBeginning: input.offsetMode === 'earliest',
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, 10_000);
        consumer
          .run({
            autoCommit: false,
            eachMessage: async ({ topic, partition, message }) => {
              if (input.partition !== undefined && partition !== input.partition) return;
              messages.push({
                topic,
                partition,
                offset: message.offset,
                key: message.key?.toString() ?? null,
                value: message.value?.toString() ?? null,
                headers: Object.fromEntries(
                  Object.entries(message.headers ?? {}).map(([key, value]) => [key, value?.toString() ?? null])
                ),
              });
              if (messages.length >= input.limit) {
                clearTimeout(timeout);
                resolve();
              }
            },
          })
          .catch(reject);
      });
      return table(messages);
    } finally {
      await consumer.disconnect();
    }
  }
  async kafkaGroups() {
    const admin = this.getKafka().admin();
    await admin.connect();
    try {
      const groups = await admin.listGroups();
      return table(
        groups.groups.map((group) => ({
          group: group.groupId,
          protocolType: group.protocolType,
        }))
      );
    } finally {
      await admin.disconnect();
    }
  }

  private getSpanner() {
    return (this.spanner ??= new Spanner({
      projectId: this.env.SPANNER_PROJECT_ID,
    }));
  }
  async ensureSpannerDemoData() {
    return (this.spannerSeed ??= this.createSpannerDemoData().catch((error) => {
      this.spannerSeed = undefined;
      throw error;
    }));
  }
  private async createSpannerDemoData() {
    const spanner = this.getSpanner();
    const instanceId = this.env.SPANNER_INSTANCE_ID;
    const databaseId = this.env.SPANNER_DATABASE_ID;
    const instance = spanner.instance(instanceId);
    const [instanceExists] = await instance.exists();
    if (!instanceExists) {
      const [, operation] = await spanner.createInstance(instanceId, {
        config: 'emulator-config',
        displayName: 'Local demo instance',
        nodes: 1,
      });
      await operation.promise();
    }

    const database = instance.database(databaseId);
    const [databaseExists] = await database.exists();
    if (!databaseExists) {
      const [, operation] = await instance.createDatabase(databaseId, {
        schema: [
          'CREATE TABLE Customers (CustomerId STRING(36) NOT NULL, Name STRING(100), Email STRING(200), Tier STRING(20)) PRIMARY KEY (CustomerId)',
          'CREATE TABLE Orders (OrderId INT64 NOT NULL, CustomerId STRING(36) NOT NULL, Status STRING(20), Total NUMERIC) PRIMARY KEY (OrderId)',
        ],
      });
      await operation.promise();
    }

    const mutations = new MutationSet();
    mutations.upsert('Customers', [
      { CustomerId: 'c-1001', Name: 'Nguyen Minh Anh', Email: 'anh@example.test', Tier: 'gold' },
      { CustomerId: 'c-1002', Name: 'Tran Gia Bao', Email: 'bao@example.test', Tier: 'standard' },
      { CustomerId: 'c-1003', Name: 'Le Thu Ha', Email: 'ha@example.test', Tier: 'gold' },
    ]);
    mutations.upsert('Orders', [
      { OrderId: 10001, CustomerId: 'c-1001', Status: 'PAID', Total: 125000 },
      { OrderId: 10002, CustomerId: 'c-1001', Status: 'SHIPPED', Total: 89000 },
      { OrderId: 10003, CustomerId: 'c-1002', Status: 'PENDING', Total: 245000 },
    ]);
    await database.writeAtLeastOnce(mutations);
  }
  async spannerInstances() {
    const start = Date.now();
    await this.ensureSpannerDemoData();
    const [instances] = await this.getSpanner().getInstances();
    return table(
      instances.map((instance) => ({
        id: instance.formattedName_.split('/').pop(),
        name: instance.formattedName_,
      })),
      Date.now() - start
    );
  }
  async spannerDatabases(instanceId: string) {
    const start = Date.now();
    const [databases] = await this.getSpanner().instance(instanceId).getDatabases();
    return table(
      databases.map((database) => ({
        id: database.formattedName_.split('/').pop(),
        name: database.formattedName_,
      })),
      Date.now() - start
    );
  }
  async spannerTables(instanceId: string, databaseId: string) {
    return this.spannerQuery(
      instanceId,
      databaseId,
      `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '' ORDER BY TABLE_NAME`
    );
  }
  async spannerSchema(instanceId: string, databaseId: string, tableName: string) {
    return this.spannerQuery(
      instanceId,
      databaseId,
      'SELECT COLUMN_NAME AS column, SPANNER_TYPE AS type, IS_NULLABLE AS nullable FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @table ORDER BY ORDINAL_POSITION',
      { table: tableName }
    );
  }
  async spannerQuery(instanceId: string, databaseId: string, sql: string, params: Record<string, unknown> = {}) {
    const start = Date.now();
    const safeSql = allowedReadStatement(sql, ['SELECT', 'WITH']);
    const [rows] = await this.getSpanner().instance(instanceId).database(databaseId).run({ sql: safeSql, params });
    const normalizedRows = (rows as Array<Record<string, unknown>>).map((row) => {
      const value = row as Record<string, unknown> & { toJSON?: () => Record<string, unknown> };
      return typeof value.toJSON === 'function' ? value.toJSON() : value;
    });
    return {
      ...table(normalizedRows, Date.now() - start),
      sql: safeSql,
    };
  }
  async spannerCreateInstance(instanceId: string) {
    const [, operation] = await this.getSpanner().createInstance(instanceId, {
      config: 'emulator-config',
      displayName: instanceId,
      nodes: 1,
    });
    await operation.promise();
    return { id: instanceId };
  }
  async spannerCreateDatabase(instanceId: string, databaseId: string) {
    const [database, operation] = await this.getSpanner().instance(instanceId).createDatabase(databaseId);
    await operation.promise();
    return { id: database.formattedName_ };
  }

  async kafkaUiStatus() {
    const start = Date.now();
    const response = await fetch(this.env.KAFKA_UI_INTERNAL_URL, {
      signal: AbortSignal.timeout(5_000),
    });
    return {
      available: response.ok,
      statusCode: response.status,
      durationMs: Date.now() - start,
      openUrl: this.env.KAFKA_UI_OPEN_URL || null,
    };
  }

  async redashStatus() {
    const start = Date.now();
    const response = await fetch(this.env.REDASH_INTERNAL_URL, {
      signal: AbortSignal.timeout(5_000),
    });
    return {
      available: response.ok,
      statusCode: response.status,
      durationMs: Date.now() - start,
      openUrl: this.env.REDASH_OPEN_URL || null,
    };
  }

  async streamContainerLogs(
    service: ServiceDefinition,
    tail: number,
    onLine: (stream: 'stdout' | 'stderr', line: string) => void
  ) {
    const container = await this.containerFor(service);
    const stream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      timestamps: true,
      tail: Math.min(Math.max(tail, 1), 1000),
    });
    const write = (kind: 'stdout' | 'stderr') => {
      let remainder = '';
      return (chunk: Buffer) => {
        remainder += chunk.toString();
        const lines = remainder.split(/\r?\n/);
        remainder = lines.pop() ?? '';
        lines.filter(Boolean).forEach((line) => onLine(kind, line));
      };
    };
    const stdout = new (await import('node:stream')).PassThrough();
    const stderr = new (await import('node:stream')).PassThrough();
    stdout.on('data', write('stdout'));
    stderr.on('data', write('stderr'));
    this.docker.modem.demuxStream(stream, stdout, stderr);
    return stream;
  }
}

export const runReadOnlyCommand = (command: string, args: string[]) =>
  new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const child = spawn(command, args, { shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
