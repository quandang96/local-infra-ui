export type JsonValue = unknown;
export type JsonRecord = Record<string, unknown>;
export type TableResult = {
  type: 'table';
  columns: { key: string; label: string; dataType: string }[];
  rows: JsonRecord[];
  metadata: { rowCount: number; durationMs: number; nextCursor: string | null };
};
export type Service = {
  id: string;
  label: string;
  compose?: string;
  container?: string;
  image: string;
  ports: string[];
  runtimeMode: 'daemon' | 'one_off';
  status: string;
  health?: string | null;
  uptime?: string | null;
  error?: string | null;
};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`/api${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? `Request failed (${response.status})`);
  return body as T;
}

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
export const del = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'DELETE', body: body === undefined ? undefined : JSON.stringify(body) });
