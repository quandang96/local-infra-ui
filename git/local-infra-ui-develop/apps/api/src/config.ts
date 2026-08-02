import { resolve } from 'node:path';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('127.0.0.1'),
  COMPOSE_PROJECT_NAME: z.string().default('git'),
  COMPOSE_FILE: z.string().default(resolve(process.cwd(), '../docker-compose.yml')),
  // Optional JSON catalog for services managed from a project-specific Compose file.
  CONTROL_CENTER_SERVICES: z.string().default(''),
  WORKSPACE_DIR: z.string().default(resolve(process.cwd(), '..')),
  TRUST_CODER_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  CODER_ACTOR_HEADER: z.string().default('x-coder-user'),
  // Comma-separated origins permitted to call the API from a different origin.
  ALLOWED_ORIGIN: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  MYSQL_HOST: z.string().default('localhost'),
  MYSQL_PORT: z.coerce.number().int().positive().default(3306),
  MYSQL_DATABASE: z.string().default('app'),
  MYSQL_USER: z.string().default('app'),
  MYSQL_PASSWORD: z.string().default('app'),
  DATASTORE_EMULATOR_HOST: z.string().default('localhost:8085'),
  DATASTORE_PROJECT_ID: z.string().default('local-project'),
  KAFKA_BOOTSTRAP_SERVERS: z.string().default('localhost:9094'),
  SPANNER_EMULATOR_HOST: z.string().default('localhost:9010'),
  SPANNER_PROJECT_ID: z.string().default('local-project'),
  SPANNER_INSTANCE_ID: z.string().default('local-instance'),
  SPANNER_DATABASE_ID: z.string().default('local-database'),
  KAFKA_UI_INTERNAL_URL: z.string().url().default('http://localhost:8080'),
  KAFKA_UI_OPEN_URL: z.string().url().optional().or(z.literal('')),
  REDASH_INTERNAL_URL: z.string().url().default('http://localhost:5000'),
  REDASH_OPEN_URL: z.string().url().optional().or(z.literal('')),
  KEYCLOAK_INTERNAL_URL: z.string().url().default('http://localhost:8082'),
  KEYCLOAK_OPEN_URL: z.string().url().optional().or(z.literal('')),
  MAILHOG_INTERNAL_URL: z.string().url().default('http://localhost:8025'),
  MAILHOG_OPEN_URL: z.string().url().optional().or(z.literal('')),
  BIGQUERY_API_ENDPOINT: z.string().url().default('http://localhost:9050'),
  BIGQUERY_PROJECT_ID: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,62}$/)
    .default('local-project'),
  // Jira credentials stay server-side. Leave blank to use the seeded local cache only.
  JIRA_API_TOKEN: z.string().default(''),
  JIRA_EMAIL: z.string().email().optional().or(z.literal('')),
  JIRA_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),
});

export type Config = z.infer<typeof schema>;
export const config = schema.parse(process.env);

process.env.DATASTORE_EMULATOR_HOST ??= config.DATASTORE_EMULATOR_HOST;
process.env.DATASTORE_PROJECT_ID ??= config.DATASTORE_PROJECT_ID;
process.env.SPANNER_EMULATOR_HOST ??= config.SPANNER_EMULATOR_HOST;
