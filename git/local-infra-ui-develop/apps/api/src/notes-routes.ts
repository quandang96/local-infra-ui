import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { type Note, AuditDatabase } from './database.js';

const noteBody = z.object({
  title: z.string().trim().min(1).max(240),
  content: z.string().max(200_000),
  tags: z
    .array(z.string().trim().min(1).max(40))
    .max(12)
    .default([])
    .transform((tags) => [...new Set(tags)]),
  isFavorite: z.boolean().default(false),
});
const noteId = z.object({ noteId: z.string().uuid() });
const passwordBody = z.object({ password: z.string().min(1).max(512) });

function configuredPassword(config: Config) {
  if (config.NOTES_PASSWORD.length < 8)
    throw Object.assign(new Error('Notes is disabled until NOTES_PASSWORD has at least 8 characters'), {
      statusCode: 503,
      code: 'NOTES_PASSWORD_NOT_CONFIGURED',
    });
  return config.NOTES_PASSWORD;
}

function signature(value: string, password: string) {
  return createHmac('sha256', password).update(value).digest('base64url');
}

function issueAccessToken(password: string) {
  const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ expiresAt, nonce: randomBytes(12).toString('base64url') })).toString(
    'base64url'
  );
  return { token: `${payload}.${signature(payload, password)}`, expiresAt: new Date(expiresAt).toISOString() };
}

function requireAccess(request: FastifyRequest, config: Config) {
  const password = configuredPassword(config);
  const token = request.headers['x-notes-access-token'];
  if (typeof token !== 'string')
    throw Object.assign(new Error('Notes password is required'), { statusCode: 401, code: 'NOTES_ACCESS_REQUIRED' });
  const [payload, receivedSignature, extra] = token.split('.');
  const expectedSignature = payload ? signature(payload, password) : '';
  if (!payload || !receivedSignature || extra || receivedSignature.length !== expectedSignature.length)
    throw Object.assign(new Error('Notes access has expired'), { statusCode: 401, code: 'NOTES_ACCESS_EXPIRED' });
  if (!timingSafeEqual(Buffer.from(receivedSignature), Buffer.from(expectedSignature)))
    throw Object.assign(new Error('Notes access has expired'), { statusCode: 401, code: 'NOTES_ACCESS_EXPIRED' });
  try {
    const { expiresAt } = z
      .object({ expiresAt: z.number().int().positive() })
      .parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
    if (expiresAt <= Date.now()) throw new Error('expired');
  } catch {
    throw Object.assign(new Error('Notes access has expired'), { statusCode: 401, code: 'NOTES_ACCESS_EXPIRED' });
  }
}

export function registerNotesRoutes(
  app: FastifyInstance,
  database: AuditDatabase,
  config: Config,
  actorFor: (request: FastifyRequest) => string
) {
  app.post('/api/notes/access', async (request) => {
    const { password: suppliedPassword } = passwordBody.parse(request.body);
    const password = configuredPassword(config);
    const supplied = Buffer.from(suppliedPassword);
    const expected = Buffer.from(password);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw Object.assign(new Error('Incorrect notes password'), { statusCode: 401, code: 'NOTES_PASSWORD_INVALID' });
    return issueAccessToken(password);
  });

  app.get('/api/notes', async (request) => {
    requireAccess(request, config);
    return { rows: await database.listNotes() };
  });

  app.get('/api/notes/public', async () => ({ rows: await database.listPublicNotes() }));

  app.post('/api/notes', async (request) => {
    requireAccess(request, config);
    const body = noteBody.parse(request.body);
    const now = new Date().toISOString();
    const actor = actorFor(request);
    return await database.saveNote({
      id: randomUUID(),
      ...body,
      isShared: false,
      shareToken: null,
      createdBy: actor,
      updatedBy: actor,
      createdAt: now,
      updatedAt: now,
    });
  });

  app.patch('/api/notes/:noteId', async (request) => {
    requireAccess(request, config);
    const { noteId: id } = noteId.parse(request.params);
    const current = await database.getNote(id);
    if (!current) throw Object.assign(new Error('Note not found'), { statusCode: 404, code: 'NOTE_NOT_FOUND' });
    return await database.saveNote({
      ...current,
      ...noteBody.parse(request.body),
      updatedBy: actorFor(request),
      updatedAt: new Date().toISOString(),
    });
  });

  app.post('/api/notes/:noteId/share', async (request) => {
    requireAccess(request, config);
    const { noteId: id } = noteId.parse(request.params);
    const { shared } = z.object({ shared: z.boolean() }).parse(request.body);
    const current = await database.getNote(id);
    if (!current) throw Object.assign(new Error('Note not found'), { statusCode: 404, code: 'NOTE_NOT_FOUND' });
    return await database.saveNote({
      ...current,
      isShared: shared,
      shareToken: null,
      updatedBy: actorFor(request),
      updatedAt: new Date().toISOString(),
    });
  });

  app.delete('/api/notes/:noteId', async (request) => {
    requireAccess(request, config);
    const { noteId: id } = noteId.parse(request.params);
    if (!(await database.deleteNote(id)))
      throw Object.assign(new Error('Note not found'), { statusCode: 404, code: 'NOTE_NOT_FOUND' });
    return { deleted: true };
  });
}
