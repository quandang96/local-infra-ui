import { resolve } from 'node:path';
import { z } from 'zod';

const jiraCustomFieldSchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  // Map this custom field to the built-in Sprint column, filter, and detail.
  role: z.enum(['sprint']).optional(),
  // Optional dot path for the value inside Jira's field payload, such as
  // "value", "name", or "0.name". Leave blank for the field value itself.
  path: z
    .string()
    .trim()
    .regex(/^$|^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/)
    .default(''),
});

const jiraCustomFieldsSchema = z
  .array(jiraCustomFieldSchema)
  .max(30)
  .superRefine((fields, context) => {
    const ids = new Set<string>();
    for (const [index, field] of fields.entries()) {
      if (ids.has(field.id))
        context.addIssue({ code: 'custom', message: `JIRA_CUSTOM_FIELDS trùng id: ${field.id}`, path: [index, 'id'] });
      ids.add(field.id);
    }
  });

export type JiraCustomField = z.infer<typeof jiraCustomFieldSchema>;

const jiraAssigneeDisplayMapSchema = z
  .record(z.string().trim().min(1).max(255), z.string().trim().min(1).max(255))
  .refine((mapping) => Object.keys(mapping).length <= 200, 'JIRA_ASSIGNEE_DISPLAY_MAP tối đa 200 mapping');

function parseJiraCustomFields(value: string, context: z.RefinementCtx) {
  try {
    return jiraCustomFieldsSchema.parse(JSON.parse(value || '[]'));
  } catch (cause) {
    context.addIssue({
      code: 'custom',
      message: `JIRA_CUSTOM_FIELDS phải là JSON array hợp lệ: ${cause instanceof Error ? cause.message : 'invalid value'}`,
    });
    return [];
  }
}

function parseJiraAssigneeDisplayMap(value: string, context: z.RefinementCtx) {
  try {
    return jiraAssigneeDisplayMapSchema.parse(JSON.parse(value || '{}'));
  } catch (cause) {
    context.addIssue({
      code: 'custom',
      message: `JIRA_ASSIGNEE_DISPLAY_MAP phải là JSON object hợp lệ: ${cause instanceof Error ? cause.message : 'invalid value'}`,
    });
    return {};
  }
}

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
  // Jira credentials stay server-side. The internal URL is optional when the
  // backend can reach the same URL users open in their browser.
  JIRA_TYPE: z.enum(['cloud', 'data_center']).default('cloud'),
  JIRA_BASE_URL: z.string().url().default('https://your-site.atlassian.net'),
  JIRA_INTERNAL_URL: z.string().url().optional().or(z.literal('')),
  JIRA_JQL: z.string().trim().min(1).max(2_000).default('project = LOCAL ORDER BY updated DESC'),
  JIRA_ALLOWED_PROJECTS: z
    .string()
    .default('LOCAL')
    .transform((value) =>
      value
        .split(',')
        .map((project) => project.trim().toUpperCase())
        .filter(Boolean)
    )
    .pipe(
      z
        .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/))
        .min(1)
        .max(30)
    ),
  // JSON array of { id, label, path? }; field ids are included in the Jira
  // search request and their selected value is kept in the local issue cache.
  JIRA_CUSTOM_FIELDS: z.string().default('[]').transform(parseJiraCustomFields),
  // JSON object mapping an assignee name from Jira to its UI display name.
  JIRA_ASSIGNEE_DISPLAY_MAP: z.string().default('{}').transform(parseJiraAssigneeDisplayMap),
  JIRA_API_TOKEN: z.string().default(''),
  JIRA_EMAIL: z.string().email().optional().or(z.literal('')),
  JIRA_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),
  // Notes stay unavailable until a password is explicitly configured.
  NOTES_PASSWORD: z.string().default(''),
});

export type Config = z.infer<typeof schema>;
export const config = schema.parse(process.env);

process.env.DATASTORE_EMULATOR_HOST ??= config.DATASTORE_EMULATOR_HOST;
process.env.DATASTORE_PROJECT_ID ??= config.DATASTORE_PROJECT_ID;
process.env.SPANNER_EMULATOR_HOST ??= config.SPANNER_EMULATOR_HOST;
